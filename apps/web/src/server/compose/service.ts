import "server-only";
import {
  EMAIL_PLACEHOLDER_KEYS,
  GeminiProvider,
  renderDraft,
  sanitizeDraft,
  templateDraft,
  type ComposeLanguage,
  type ComposeTone,
  type EmailDraft,
} from "@ufa/ai";
import { getFieldDef } from "@ufa/shared";
import { redact } from "@ufa/security";
import { asUser, db, type Actor } from "../db";
import { readStored } from "../documents/conflicts";
import { env } from "../env";

/**
 * "Write email" in the extension. Gemini (when the operator enabled it and the
 * user did not switch cloud AI off) writes a draft with placeholders from the
 * user's request; identifiers in the request are masked first and profile values
 * are never sent. The server fills the placeholders with the user's own values.
 * Without Gemini, or over the daily limit, a template is used. Drafts are not
 * stored; only counts go to ai_requests / ai_usage.
 */

export interface ComposeInput {
  instruction: string;
  tone: ComposeTone;
  language: ComposeLanguage;
  previous?: EmailDraft | null;
}

export interface ComposeResult {
  subject: string;
  body: string;
  /** The draft with placeholders: sent back when the user asks for a change (holds no values). */
  template: EmailDraft;
  source: "gemini" | "template";
  /** Why a template was used instead of Gemini (shown to the user). */
  notice: string | null;
  used: string[];
  missing: Array<{ key: string; label: string }>;
}

const g = globalThis as unknown as { __ufaComposeGemini?: GeminiProvider | null };

function gemini(): GeminiProvider | null {
  if (g.__ufaComposeGemini !== undefined) return g.__ufaComposeGemini;
  const e = env();
  g.__ufaComposeGemini = e.GEMINI_ENABLED && e.GEMINI_API_KEY ? new GeminiProvider({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL, baseUrl: e.GEMINI_BASE_URL }) : null;
  return g.__ufaComposeGemini;
}

export async function composeEmail(actor: Actor, input: ComposeInput): Promise<ComposeResult> {
  const e = env();
  const { values, cloudAiAllowed, usedToday } = await asUser(actor, async (tx) => {
    const rows = await tx<{ field_key: string; value: string; is_encrypted: boolean }[]>`
      select field_key, value, is_encrypted from profile_fields
       where user_id = ${actor.id} and deleted_at is null and field_key in ${tx(EMAIL_PLACEHOLDER_KEYS as string[])}`;
    const [pref] = await tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${actor.id}`;
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from ai_requests
       where user_id = ${actor.id} and operation = 'compose_email' and provider = 'gemini' and success and created_at >= date_trunc('day', now())`;
    return { values: new Map(rows.map((r) => [r.field_key, readStored(r)])), cloudAiAllowed: pref?.cloud_ai_enabled ?? true, usedToday: count!.n };
  });

  // Identifiers the user may have typed (Aadhaar, PAN, account numbers, e-mail addresses, phone numbers) never reach the model.
  const instruction = redact(input.instruction);
  const previous = input.previous ? sanitizeDraft({ subject: redact(input.previous.subject), body: redact(input.previous.body) }) : null;

  let template: EmailDraft | null = null;
  let source: ComposeResult["source"] = "template";
  let notice: string | null = null;
  const provider = gemini();
  if (!provider) notice = "AI writing is not enabled on this server, so a ready template was used.";
  else if (!cloudAiAllowed) notice = "You switched cloud AI off (Settings → AI assistance), so a ready template was used.";
  else if (usedToday >= e.COMPOSE_DAILY_LIMIT) notice = `Daily limit of ${e.COMPOSE_DAILY_LIMIT} AI drafts reached, so a ready template was used.`;
  else {
    const started = Date.now();
    try {
      // Only the NAMES of details the user actually has (the full name always), so the model does not plan around empty ones.
      const keys = EMAIL_PLACEHOLDER_KEYS.filter((k) => values.has(k) || k === "personal.full_name").map((key) => ({ key, label: getFieldDef(key)!.label.en }));
      const r = await provider.composeEmail({ instruction, tone: input.tone, language: input.language, keys, previous });
      template = r.draft;
      source = "gemini";
      await record(actor, provider.model, Date.now() - started, true, r.usage);
    } catch (err) {
      console.warn(`[ai] gemini compose_email failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      await record(actor, provider.model, Date.now() - started, false).catch(() => {});
      notice = "The AI could not write a draft right now, so a ready template was used.";
    }
  }
  // A follow-up request without AI keeps the user's current draft instead of starting over.
  template ??= previous && source === "template" && input.previous ? previous : templateDraft({ instruction, tone: input.tone, language: input.language }, new Set(values.keys()));

  const rendered = renderDraft(template, values);
  return { subject: rendered.subject, body: rendered.body, template, source, notice, used: rendered.used, missing: rendered.missing };
}

async function record(actor: Actor, model: string, latencyMs: number, success: boolean, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, 'gemini', ${model}, 'compose_email', ${latencyMs}, ${success}, ${success ? null : "provider_error"}, false,
            ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
  if (!success) return;
  await db().system`
    insert into ai_usage (user_id, period, provider, request_count, input_tokens, output_tokens)
    values (${actor.id}, current_date, 'gemini', 1, ${usage?.inputTokens ?? 0}, ${usage?.outputTokens ?? 0})
    on conflict (user_id, period, provider) do update
       set request_count = ai_usage.request_count + 1,
           input_tokens = ai_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_usage.output_tokens + excluded.output_tokens`;
}
