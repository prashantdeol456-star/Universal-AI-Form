import { z } from "zod";
import { answerSystemPrompt, composeSystemPrompt, composeUserPrompt, sanitizeAnswer, sanitizeDraft, type AnswerDraft, type AnswerInput, type ComposeEmailInput, type EmailDraft } from "../compose";
import { EVIDENCE_JSON_SCHEMA, evidenceSystemPrompt, evidenceUserPrompt, type EvidenceAnswerInput } from "../knowledge/evidence";
import type { AIProvider, FieldSuggestion, MapFieldsInput, MapFieldsResult, TokenUsage } from "./types";

/**
 * Google Gemini as the fallback for hard fields (spec §30). Server-side only:
 * the API key never leaves the backend (spec §55) and is sent in a header, not
 * the URL, so it cannot end up in access logs.
 *
 * What is sent (spec §66): for each unresolved field its label, section, input
 * type and up to 12 option labels, plus the list of profile field KEYS and their
 * generic English names. Never profile values, documents, page HTML or URLs.
 *
 * Uses the REST generateContent endpoint with JSON-schema structured output
 * (generationConfig.responseMimeType + responseJsonSchema), so replies are machine-checkable; they
 * are validated again with zod before use.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Maximum fields per request (cost control). */
  batchSize?: number;
}

/** Gemini's self-reported confidence is capped; its answers are always confirmed by the user. */
export const GEMINI_MAX_CONFIDENCE = 0.85;

const reply = z.object({
  mappings: z.array(z.object({ field_id: z.string(), profile_field: z.string(), confidence: z.number().min(0).max(1) })),
});

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class GeminiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
  readonly model: string;

  constructor(private readonly opts: GeminiOptions) {
    if (!opts.apiKey) throw new Error("GEMINI_API_KEY is not set");
    this.model = opts.model;
  }

  private async generate(body: unknown): Promise<{ text: string; usage: TokenUsage }> {
    const url = `${(this.opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")}/models/${encodeURIComponent(this.model)}:generateContent`;
    for (let attempt = 0; ; attempt++) {
      const res = await (this.opts.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 25_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
        if (!text) throw new GeminiError(502, `Gemini returned no content (${data.candidates?.[0]?.finishReason ?? "unknown"})`);
        return { text, usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 } };
      }
      if (attempt === 0 && RETRYABLE.has(res.status)) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      // Never include the response body: it could echo request content.
      throw new GeminiError(res.status, `Gemini request failed with HTTP ${res.status}`);
    }
  }

  /**
   * Drafts an email (extension "Write email"). Receives the user's request (identifiers
   * already masked by the caller) and placeholder KEYS only — never profile values.
   */
  async composeEmail(input: ComposeEmailInput): Promise<{ draft: EmailDraft; usage: TokenUsage }> {
    const { text, usage } = await this.generate({
      systemInstruction: { parts: [{ text: composeSystemPrompt(input) }] },
      contents: [{ role: "user", parts: [{ text: composeUserPrompt(input) }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
      },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GeminiError(502, "Gemini returned non-JSON output");
    }
    const draft = sanitizeDraft(parsed);
    if (!draft) throw new GeminiError(502, "Gemini output did not match the expected schema");
    return { draft, usage };
  }

  /**
   * Writes an answer to an open form question from the user's professional facts.
   * The caller sends facts only with the user's consent (never IDs or contact details).
   */
  /**
   * Answers from excerpts of the user's documents (knowledge base). The caller sends only
   * excerpts of documents the user allowed for cloud AI; the raw reply is validated by
   * validateEvidenceReply against those excerpts.
   */
  async answerFromEvidence(input: EvidenceAnswerInput): Promise<{ raw: string; usage: TokenUsage }> {
    const { text, usage } = await this.generate({
      systemInstruction: { parts: [{ text: evidenceSystemPrompt(input) }] },
      contents: [{ role: "user", parts: [{ text: evidenceUserPrompt(input) }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseJsonSchema: EVIDENCE_JSON_SCHEMA },
    });
    return { raw: text, usage };
  }

  async answerQuestion(input: AnswerInput): Promise<{ draft: AnswerDraft; usage: TokenUsage }> {
    const { text, usage } = await this.generate({
      systemInstruction: { parts: [{ text: answerSystemPrompt(input) }] },
      contents: [{ role: "user", parts: [{ text: `Question from the form:
"""${input.question.slice(0, 1000)}"""` }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { answer: { type: "string" }, missing: { type: "array", items: { type: "string" } } },
          required: ["answer", "missing"],
        },
      },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GeminiError(502, "Gemini returned non-JSON output");
    }
    const draft = sanitizeAnswer(parsed, input.maxWords);
    if (!draft) throw new GeminiError(502, "Gemini output did not match the expected schema");
    return { draft, usage };
  }

  async mapFields(input: MapFieldsInput): Promise<MapFieldsResult> {
    const allowed = new Set(input.candidates.map((c) => c.key));
    const batchSize = this.opts.batchSize ?? 40;
    const suggestions: FieldSuggestion[] = [];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for (let i = 0; i < input.fields.length; i += batchSize) {
      const batch = input.fields.slice(i, i + batchSize);
      const { text, usage: u } = await this.generate({
        systemInstruction: {
          parts: [
            {
              text:
                "You map fields of Indian online application forms (labels may be English, Hindi or Hinglish) to the keys of a " +
                "personal profile. For each field return exactly one key from the allowed list, or \"none\" when no key clearly " +
                "fits (for example exam centre, height, father's occupation). A wrong key is much worse than \"none\". " +
                "confidence is your probability (0..1) that the key is correct.\n\nAllowed keys:\n" +
                input.candidates.map((c) => `${c.key} = ${c.label}`).join("\n"),
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: JSON.stringify(batch.map((f) => ({ field_id: f.id, label: f.label, section: f.section, type: f.kind, options: f.options.slice(0, 12) }))) }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: {
              mappings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field_id: { type: "string" },
                    profile_field: { type: "string", enum: [...allowed, "none"] },
                    confidence: { type: "number" },
                  },
                  required: ["field_id", "profile_field", "confidence"],
                },
              },
            },
            required: ["mappings"],
          },
        },
      });
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GeminiError(502, "Gemini returned non-JSON output");
      }
      const r = reply.safeParse(parsed);
      if (!r.success) throw new GeminiError(502, "Gemini output did not match the expected schema");
      const ids = new Set(batch.map((f) => f.id));
      for (const m of r.data.mappings) {
        if (!ids.has(m.field_id)) continue;
        const key = m.profile_field === "none" || !allowed.has(m.profile_field) ? null : m.profile_field;
        suggestions.push({ fieldId: m.field_id, profileField: key, confidence: Math.min(m.confidence, GEMINI_MAX_CONFIDENCE) });
      }
    }
    return { suggestions, usage };
  }
}
