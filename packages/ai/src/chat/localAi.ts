import { z } from "zod";
import { getFieldDef, PROFILE_FIELDS, validateValue } from "@ufa/shared";
import type { ChatFact } from "./facts";

/**
 * Optional fallback for chat messages the rules did not understand, using a
 * self-hosted model behind Ollama. Same safety contract as document extraction:
 * schema-constrained JSON, field keys restricted to the catalog, zod re-validation,
 * catalog validators, confidence capped — and the user still confirms each fact.
 * Phase 5 folds this into the shared AIProvider/orchestrator.
 */
export interface ChatLocalAIConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const MAX_CHAT_MODEL_CONFIDENCE = 0.8;

/** Anti-hallucination check: some significant token of the value must occur in the user's message. */
export function appearsIn(message: string, value: string): boolean {
  const m = message.toLowerCase();
  const tokens = value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 || /^\d+$/.test(t));
  return tokens.length > 0 && tokens.some((t) => m.includes(t));
}

const replySchema = z.object({
  facts: z.array(z.object({ field_key: z.string(), value: z.string().max(300), confidence: z.number().min(0).max(1) })).max(20),
});

export class ChatLocalAIExtractor {
  constructor(private readonly cfg: ChatLocalAIConfig) {}

  async extract(message: string): Promise<ChatFact[]> {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    const res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      body: JSON.stringify({
        model: this.cfg.model,
        stream: false,
        options: { temperature: 0 },
        format: {
          type: "object",
          properties: {
            facts: {
              type: "array",
              items: {
                type: "object",
                properties: { field_key: { type: "string", enum: keys }, value: { type: "string" }, confidence: { type: "number" } },
                required: ["field_key", "value", "confidence"],
              },
            },
          },
          required: ["facts"],
        },
        messages: [
          {
            role: "system",
            content:
              "Extract personal facts that the user explicitly states about THEMSELVES or their family, for an Indian form-filling profile. " +
              "The message may be English, Hindi or Hinglish. Only include facts that are clearly stated; never guess; " +
              "return an empty list for questions, greetings or anything unclear. Dates as DD/MM/YYYY. Reply with JSON only.",
          },
          { role: "user", content: message.slice(0, 2000) },
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

    const out: ChatFact[] = [];
    for (const f of reply.data.facts) {
      const def = getFieldDef(f.field_key);
      if (!def) continue;
      const r = validateValue(def.validator, f.value, { options: def.options });
      // Only accept values that literally appear in what the user wrote (no invented data).
      if (!r.ok || !appearsIn(message, f.value)) continue;
      out.push({ fieldKey: f.field_key, value: r.value, confidence: Math.min(f.confidence, MAX_CHAT_MODEL_CONFIDENCE), method: "local_ai", raw: f.value });
    }
    return out;
  }
}
