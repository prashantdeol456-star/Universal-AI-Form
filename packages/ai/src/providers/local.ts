import { z } from "zod";
import { JOB_ANALYSIS_SCHEMA, jobAnalysisSystemPrompt, jobAnalysisUserPrompt, type JobAnalysisInput } from "../jobs/analysis";
import { EVIDENCE_JSON_SCHEMA, evidenceSystemPrompt, evidenceUserPrompt, type EvidenceAnswerInput } from "../knowledge/evidence";
import { localMappingFormat, localMappingSystemPrompt, localMappingUserPrompt } from "./prompt";
import type { AIProvider, FieldSuggestion, MapFieldsInput, MapFieldsResult } from "./types";

/**
 * Self-hosted model behind Ollama's HTTP API (works the same for llama.cpp's
 * Ollama-compatible server). Runs on the VPS or a private GPU box; the model is
 * configuration (LOCAL_AI_MODEL), never hard-coded.
 */
export interface LocalAIOptions {
  baseUrl: string;
  model: string;
  embedModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The model's self-reported confidence never exceeds this. */
export const LOCAL_MAX_CONFIDENCE = 0.8;
const BATCH = 25;

const mapReply = z.object({
  mappings: z.array(z.object({ field_id: z.string(), profile_field: z.string(), confidence: z.number().min(0).max(1) })).max(BATCH),
});

export class LocalAIProvider implements AIProvider {
  readonly name = "local" as const;
  readonly model: string;

  constructor(private readonly opts: LocalAIOptions) {
    this.model = opts.model;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`Local AI returned HTTP ${res.status}`);
    return res.json();
  }

  async mapFields(input: MapFieldsInput): Promise<MapFieldsResult> {
    const allowed = new Set(input.candidates.map((c) => c.key));
    const out: FieldSuggestion[] = [];
    for (let i = 0; i < input.fields.length; i += BATCH) {
      const batch = input.fields.slice(i, i + BATCH);
      const body = (await this.post("/api/chat", {
        model: this.model,
        stream: false,
        options: { temperature: 0 },
        format: localMappingFormat([...allowed]),
        messages: [
          { role: "system", content: localMappingSystemPrompt(input.candidates) },
          { role: "user", content: localMappingUserPrompt(batch) },
        ],
      })) as { message?: { content?: string } };

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.message?.content ?? "");
      } catch {
        throw new Error("Local AI returned non-JSON output");
      }
      const reply = mapReply.safeParse(parsed);
      if (!reply.success) throw new Error("Local AI output did not match the expected schema");
      const ids = new Set(batch.map((f) => f.id));
      for (const m of reply.data.mappings) {
        if (!ids.has(m.field_id)) continue; // ignore invented field ids
        const key = m.profile_field === "none" || !allowed.has(m.profile_field) ? null : m.profile_field;
        out.push({ fieldId: m.field_id, profileField: key, confidence: Math.min(m.confidence, LOCAL_MAX_CONFIDENCE) });
      }
    }
    return { suggestions: out };
  }

  /** Knowledge base answers on the self-hosted model (no data leaves the server). Reply validated by the caller. */
  async answerFromEvidence(input: EvidenceAnswerInput): Promise<{ raw: string }> {
    const body = (await this.post("/api/chat", {
      model: this.model,
      stream: false,
      options: { temperature: 0.1 },
      format: EVIDENCE_JSON_SCHEMA,
      messages: [
        { role: "system", content: evidenceSystemPrompt(input) },
        { role: "user", content: evidenceUserPrompt(input) },
      ],
    })) as { message?: { content?: string } };
    return { raw: body.message?.content ?? "" };
  }

  /** Job description summary on the self-hosted model. Reply validated by the caller. */
  async analyzeJob(input: JobAnalysisInput): Promise<{ raw: string }> {
    const body = (await this.post("/api/chat", {
      model: this.model,
      stream: false,
      options: { temperature: 0.1 },
      format: JOB_ANALYSIS_SCHEMA,
      messages: [
        { role: "system", content: jobAnalysisSystemPrompt() },
        { role: "user", content: jobAnalysisUserPrompt(input) },
      ],
    })) as { message?: { content?: string } };
    return { raw: body.message?.content ?? "" };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.opts.embedModel) throw new Error("No embedding model configured");
    const body = (await this.post("/api/embed", { model: this.opts.embedModel, input: texts })) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error("Unexpected embedding response");
    return body.embeddings;
  }
}
