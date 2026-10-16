import "server-only";
import { validateEvidenceReply, EvidenceReplyError, type EvidenceExcerpt } from "@ufa/ai";
import { redact } from "@ufa/security";
import { modelRouter } from "../ai/router";
import { asUser, type Actor } from "../db";
import { env } from "../env";
import { retrieve } from "./retrieval";
import type { KnowledgeAnswer, KnowledgeExcerpt, KnowledgeFact } from "./types";

/**
 * Answers a question from the user's own documents and profile (purpose `extract_facts`).
 *
 *  1. Retrieve evidence first. No evidence → `not_found` (no model call).
 *  2. The user's sources disagree → `conflict` (no model call; the user decides).
 *  3. Model choice:
 *     - a configured local model (self-hosted) may read all excerpts;
 *     - otherwise cloud AI, only when cloud AI is on for the user AND only with excerpts of
 *       documents the user allowed for cloud AI (profile values only with profile sharing on);
 *     - a failed local model never falls back to the cloud.
 *  4. The reply is validated against the excerpts (references + exact quotes); anything
 *     unsupported is dropped. Provider errors, invalid JSON and empty support all end in
 *     `excerpts_only`: the excerpts with their sources, no generated text.
 * Nothing here marks a fact as verified.
 */
export async function answerFromKnowledge(actor: Actor, input: { question: string; mode?: "fact" | "draft" }): Promise<KnowledgeAnswer> {
  const mode = input.mode ?? "fact";
  const r = await retrieve(actor, input.question, { limit: 6 });
  const base = { excerpts: r.excerpts, facts: r.facts, conflicts: r.conflicts };
  const none = (status: KnowledgeAnswer["status"], reason: string | null, provider: "local" | "gemini" | null = null, dropped = 0): KnowledgeAnswer => ({
    status,
    summary: null,
    statements: [],
    ...base,
    engine: { provider, reason, dropped },
  });

  if (r.status === "not_found") return none("not_found", "no_evidence");
  if (r.conflicts.length) return none("conflict", "sources_disagree");

  const router = modelRouter();
  const local = router.local("extract_facts");
  const { cloudAi, sharing, usedToday } = await asUser(actor, async (tx) => {
    const [p] = await tx<{ cloud_ai_enabled: boolean; ai_profile_sharing: boolean }[]>`select cloud_ai_enabled, ai_profile_sharing from profiles where user_id = ${actor.id}`;
    const [c] = await tx<{ n: number }[]>`
      select count(*)::int as n from ai_requests where user_id = ${actor.id} and operation = 'knowledge_answer' and success and created_at >= date_trunc('day', now())`;
    return { cloudAi: p?.cloud_ai_enabled ?? true, sharing: p?.ai_profile_sharing ?? false, usedToday: c!.n };
  });

  const toEvidence = (ex: KnowledgeExcerpt[], facts: KnowledgeFact[]): EvidenceExcerpt[] => [
    ...ex.map((e) => ({ ref: e.ref, label: `${e.documentTitle}${e.page ? `, page ${e.page}` : ""}${e.section ? `, ${e.section}` : ""}`, text: redact(e.text) })),
    // Sensitive values (ID numbers, bank details) never go to a model.
    ...facts.filter((f) => !f.sensitive).map((f, i) => ({ ref: `P${i + 1}`, label: `Profile: ${f.label}${f.verified ? " (confirmed)" : " (not confirmed)"}`, text: `${f.label}: ${f.value}` })),
  ];

  let provider: "local" | "gemini";
  let evidence: EvidenceExcerpt[];
  let call: () => Promise<{ raw: string; usage?: { inputTokens: number; outputTokens: number } }>;
  let model: string;
  if (local) {
    provider = "local";
    model = local.model;
    evidence = toEvidence(r.excerpts, r.facts);
    call = () => local.answerFromEvidence({ question: input.question, excerpts: evidence, mode });
  } else {
    const allowedExcerpts = r.excerpts.filter((e) => e.cloudAiAllowed);
    evidence = toEvidence(allowedExcerpts, sharing ? r.facts : []);
    if (!evidence.length) {
      return none("excerpts_only", r.excerpts.length ? "cloud_not_allowed_for_these_documents" : "cloud_not_allowed_for_profile");
    }
    const decision = router.cloud("extract_facts", { consent: cloudAi, usedToday, dailyLimit: env().COMPOSE_DAILY_LIMIT });
    if (!decision.allowed) return none("excerpts_only", decision.reason);
    provider = "gemini";
    model = decision.provider.model;
    const gemini = decision.provider;
    call = () => gemini.answerFromEvidence({ question: input.question, excerpts: evidence, mode });
  }

  const started = Date.now();
  let raw: string;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    ({ raw, usage } = await call());
  } catch (err) {
    console.warn(`[ai] ${provider} knowledge_answer failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    await record(actor, provider, model, Date.now() - started, false, "provider_error").catch(() => {});
    return none("excerpts_only", "provider_error", provider);
  }
  try {
    const v = validateEvidenceReply(raw, evidence, mode === "draft" ? 180 : 80);
    await record(actor, provider, model, Date.now() - started, true, null, usage).catch(() => {});
    if (v.notFound) return none(r.excerpts.length ? "excerpts_only" : "not_found", "model_found_no_support", provider, v.dropped);
    return { status: "answered", summary: v.summary, statements: v.statements, ...base, engine: { provider, reason: null, dropped: v.dropped } };
  } catch (err) {
    if (!(err instanceof EvidenceReplyError)) throw err;
    await record(actor, provider, model, Date.now() - started, false, "invalid_output").catch(() => {});
    return none("excerpts_only", "invalid_model_output", provider);
  }
}

async function record(actor: Actor, provider: string, model: string, latencyMs: number, success: boolean, errorCode: string | null, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, ${provider}, ${model}, 'knowledge_answer', ${latencyMs}, ${success}, ${errorCode}, false,
            ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
}
