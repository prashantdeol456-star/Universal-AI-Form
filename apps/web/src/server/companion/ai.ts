import "server-only";
import type { AIPurpose } from "@ufa/ai";
import { redact } from "@ufa/security";
import { modelRouter } from "../ai/router";
import { asUser, type Actor } from "../db";
import { env } from "../env";

/**
 * Model calls for the local companion (purposes plan_task, summarize_local_document,
 * review_task_result). A configured local model first. Cloud AI only when the user's cloud
 * switch is on AND, for file content, the device allows cloud AI for its excerpts (default
 * off). A failed local model never falls back to the cloud. Without a model the caller uses
 * its rule-based result and says so. Model output is advice only: it never adds steps,
 * folders or commands (plans are validated against the allowlists before they are shown).
 */
export type LocalEngine = { provider: "local" | "gemini" | "rules"; reason: string | null };

export async function runLocalAgentModel(actor: Actor, purpose: AIPurpose, opts: { cloudAllowed: boolean; system: string; user: string; schema: object }): Promise<{ raw: string | null; engine: LocalEngine }> {
  const router = modelRouter();
  const local = router.local(purpose);
  let provider: "local" | "gemini";
  let model: string;
  let call: () => Promise<{ raw: string; usage?: { inputTokens: number; outputTokens: number } }>;
  if (local) {
    provider = "local";
    model = local.model;
    call = () => local.generateStructured({ system: opts.system, user: opts.user, schema: opts.schema });
  } else {
    if (!opts.cloudAllowed) return { raw: null, engine: { provider: "rules", reason: "cloud_not_allowed" } };
    const { consent, used } = await asUser(actor, async (tx) => {
      const [p] = await tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${actor.id}`;
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from ai_requests where user_id = ${actor.id} and operation = 'local_agent' and success and created_at >= date_trunc('day', now())`;
      return { consent: p?.cloud_ai_enabled ?? true, used: c!.n };
    });
    const d = router.cloud(purpose, { consent, usedToday: used, dailyLimit: env().COMPANION_AI_DAILY_LIMIT });
    if (!d.allowed) return { raw: null, engine: { provider: "rules", reason: d.reason } };
    provider = "gemini";
    model = d.provider.model;
    const g = d.provider;
    call = () => g.generateStructured({ system: opts.system, user: opts.user, schema: opts.schema });
  }
  const started = Date.now();
  try {
    const { raw, usage } = await call();
    await record(actor, provider, model, Date.now() - started, true, null, usage).catch(() => {});
    return { raw, engine: { provider, reason: null } };
  } catch (err) {
    console.warn(`[ai] ${provider} ${purpose} failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    await record(actor, provider, model, Date.now() - started, false, "provider_error").catch(() => {});
    return { raw: null, engine: { provider: "rules", reason: "provider_error" } };
  }
}

async function record(actor: Actor, provider: string, model: string, latencyMs: number, success: boolean, errorCode: string | null, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, ${provider}, ${model}, 'local_agent', ${latencyMs}, ${success}, ${errorCode}, false, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
}

/** Rule-based reading of command output: pass/fail from the exit code, plus the lines that look like errors. */
export function reviewOutputByRules(r: { exitCode: number | null; timedOut: boolean; stopped?: boolean }, output: string) {
  const lines = output.split(/\r?\n/);
  const errors = lines.filter((l) => /\b(error|failed|failing|fail|exception|✗|×)\b/i.test(l) && l.trim().length < 300).slice(-15);
  const verdict = r.stopped ? "stopped" : r.timedOut ? "timed_out" : r.exitCode === 0 ? "passed" : "failed";
  const summary =
    verdict === "passed" ? "The command finished successfully (exit code 0)." : verdict === "timed_out" ? "The command took too long and was stopped." : verdict === "stopped" ? "The command was stopped by the emergency stop." : `The command failed (exit code ${r.exitCode ?? "unknown"}).`;
  return { verdict, summary, errorLines: errors };
}
