import { z } from "zod";
import type { DocumentType } from "@ufa/shared";
import type { ExtractedCandidate } from "./types";

/**
 * Document field extraction with a self-hosted model served by Ollama
 * (same VPS / private GPU server — never a third-party API).
 *
 * Safety: the model only returns JSON constrained by a schema whose field keys
 * are limited to what this document type may contain; the reply is validated
 * again with zod, unknown keys are dropped, and the model's own confidence is
 * capped so that rules + user confirmation stay in charge.
 * The full AIProvider/orchestrator abstraction arrives in phase 5; this class
 * will become LocalAIProvider.extractDocument().
 */
export interface LocalAIConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const MAX_MODEL_CONFIDENCE = 0.85;
const MAX_INPUT_CHARS = 6000;

const replySchema = z.object({
  fields: z
    .array(
      z.object({
        field_key: z.string(),
        value: z.string().max(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(40),
});

export class LocalAIDocumentExtractor {
  constructor(private readonly cfg: LocalAIConfig) {}

  async extract(type: DocumentType, text: string, allowedKeys: string[]): Promise<ExtractedCandidate[]> {
    if (allowedKeys.length === 0 || !text.trim()) return [];
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const schema = {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field_key: { type: "string", enum: allowedKeys },
              value: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["field_key", "value", "confidence"],
          },
        },
      },
      required: ["fields"],
    };

    const res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
      body: JSON.stringify({
        model: this.cfg.model,
        stream: false,
        format: schema,
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              `You read OCR text from an Indian ${type.replace(/_/g, " ")} and extract profile fields. ` +
              `Allowed field keys: ${allowedKeys.join(", ")}. ` +
              "Only include a field if its value is clearly present in the text. Never guess or invent values. " +
              "Dates must be YYYY-MM-DD. Names exactly as printed. confidence is 0..1. Reply with JSON only.",
          },
          { role: "user", content: text.slice(0, MAX_INPUT_CHARS) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Local AI returned HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.message?.content ?? "");
    } catch {
      throw new Error("Local AI returned non-JSON output");
    }
    const reply = replySchema.safeParse(parsed);
    if (!reply.success) throw new Error("Local AI output did not match the expected schema");

    const allowed = new Set(allowedKeys);
    return reply.data.fields
      .filter((f) => allowed.has(f.field_key) && f.value.trim())
      .map((f) => ({
        fieldKey: f.field_key,
        value: f.value.trim(),
        confidence: Math.min(f.confidence, MAX_MODEL_CONFIDENCE),
        method: "local_ai" as const,
      }));
  }
}
