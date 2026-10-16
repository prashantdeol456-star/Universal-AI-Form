import "server-only";
import { JobAnalysisError, validateJobAnalysis } from "@ufa/ai";
import { redact } from "@ufa/security";
import { modelRouter } from "../ai/router";
import { asUser, type Actor } from "../db";
import { env } from "../env";
import { HttpError, notFound } from "../http";
import type { JobAnalysisView } from "./types";

/**
 * AI summary of a job description (purpose `match_job`). Only the public job text is sent,
 * never the user's profile or documents. A configured local model is used first; cloud AI
 * only when the user's cloud AI switch is on and the daily limit allows it; a failed local
 * model never falls back to the cloud. Points without an exact quote are dropped.
 */
export async function analyzeJob(actor: Actor, jobId: string): Promise<JobAnalysisView> {
  const { job, cloudAi, usedToday } = await asUser(actor, async (tx) => {
    const [job] = await tx<{ title: string; description: string }[]>`select title, description from job_listings where id = ${jobId} and user_id = ${actor.id}`;
    if (!job) throw notFound("Job not found");
    const [p] = await tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${actor.id}`;
    const [c] = await tx<{ n: number }[]>`
      select count(*)::int as n from ai_requests where user_id = ${actor.id} and operation = 'job_analysis' and success and created_at >= date_trunc('day', now())`;
    return { job, cloudAi: p?.cloud_ai_enabled ?? true, usedToday: c!.n };
  });
  if (job.description.replace(/\s/g, "").length < 80) throw new HttpError(422, "too_little_text", "This job has too little description to summarise. Paste the full description when adding it.");

  const router = modelRouter();
  const local = router.local("match_job");
  let provider: "local" | "gemini";
  let model: string;
  let call: () => Promise<{ raw: string; usage?: { inputTokens: number; outputTokens: number } }>;
  if (local) {
    provider = "local";
    model = local.model;
    call = () => local.analyzeJob(job);
  } else {
    const d = router.cloud("match_job", { consent: cloudAi, usedToday, dailyLimit: env().COMPOSE_DAILY_LIMIT });
    if (!d.allowed) {
      const why: Record<string, string> = {
        no_consent: "Cloud AI is switched off in your settings, and no self-hosted model is configured.",
        local_only: "This server uses local AI only, and no local model is configured.",
        not_configured: "No AI model is configured on this server.",
        over_budget: "Today's AI limit is used up.",
        not_implemented: "AI job summaries are not available.",
      };
      throw new HttpError(409, `ai_${d.reason}`, why[d.reason] ?? "AI is not available.");
    }
    provider = "gemini";
    model = d.provider.model;
    const gemini = d.provider;
    call = () => gemini.analyzeJob(job);
  }

  const started = Date.now();
  let raw: string;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    ({ raw, usage } = await call());
  } catch (err) {
    console.warn(`[ai] ${provider} job_analysis failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    await record(actor, provider, model, Date.now() - started, false, "provider_error").catch(() => {});
    throw new HttpError(502, "ai_failed", "The AI model did not answer. The job details below are unchanged.");
  }
  let v;
  try {
    v = validateJobAnalysis(raw, job.description);
  } catch (err) {
    if (!(err instanceof JobAnalysisError)) throw err;
    await record(actor, provider, model, Date.now() - started, false, "invalid_output").catch(() => {});
    throw new HttpError(502, "ai_invalid_output", "The AI reply could not be checked against the job description, so it was discarded.");
  }
  await record(actor, provider, model, Date.now() - started, true, null, usage).catch(() => {});
  const view: JobAnalysisView = { provider, ...v, analyzedAt: new Date().toISOString() };
  await asUser(actor, (tx) => tx`update job_listings set ai_analysis = ${tx.json(view as never)}, ai_analyzed_at = now() where id = ${jobId} and user_id = ${actor.id}`);
  return view;
}

async function record(actor: Actor, provider: string, model: string, latencyMs: number, success: boolean, errorCode: string | null, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, ${provider}, ${model}, 'job_analysis', ${latencyMs}, ${success}, ${errorCode}, false, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
}
