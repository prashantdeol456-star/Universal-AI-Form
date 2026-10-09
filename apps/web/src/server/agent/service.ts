import "server-only";
import { extractChatFacts, GeminiProvider, templateAnswer, wordLimitOf, type AnswerDraft } from "@ufa/ai";
import { normalizeLabel } from "@ufa/form-engine";
import { getFieldDef, isCatalogKey } from "@ufa/shared";
import { redact } from "@ufa/security";
import type { TransactionSql } from "@ufa/db";
import { audit } from "../audit";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { readStored } from "../documents/conflicts";
import { env } from "../env";
import { badRequest, HttpError, notFound } from "../http";
import { updateFieldTx } from "../profile/service";

/**
 * The assistant in the extension ("Fill form" chat):
 *  - absorbMessage: facts the user tells it ("meri city Noida hai") go straight into the profile
 *    (everyday details only; ID numbers stay with the dashboard's confirm flow);
 *  - answerQuestion: the user's answer to a form question is saved to the matching profile field,
 *    or to their saved answers when it is not a profile field — so the same question is filled next time;
 *  - draftAnswer: an answer to an open question ("Tell us about yourself") from their professional profile —
 *    by Gemini only with their explicit consent, otherwise from a template.
 */

export const normalizeQuestion = (q: string) => normalizeLabel(q).slice(0, 500) || q.trim().toLowerCase().slice(0, 500);

// --- Saved answers ------------------------------------------------------------------------

export interface SavedAnswerView {
  id: string;
  question: string;
  answer: string;
  domain: string | null;
  useCount: number;
  updatedAt: string;
}

export async function saveAnswer(actor: Actor, input: { question: string; answer: string; kind?: string | null; domain?: string | null }, tx?: TransactionSql) {
  const answer = input.answer.trim();
  if (!answer) throw badRequest("The answer is empty");
  if (answer.length > 5000) throw badRequest("The answer is too long (5000 characters max)");
  const run = (t: TransactionSql) => t`
    insert into saved_answers (user_id, question, question_norm, answer, field_kind, domain)
    values (${actor.id}, ${input.question.trim().slice(0, 500)}, ${normalizeQuestion(input.question)}, ${encryptValue(answer)}, ${input.kind ?? null}, ${input.domain ?? null})
    on conflict (user_id, question_norm) do update
       set answer = excluded.answer, question = excluded.question, field_kind = excluded.field_kind, domain = coalesce(excluded.domain, saved_answers.domain)`;
  if (tx) await run(tx);
  else await asUser(actor, run);
}

/** Saved answers for these question labels (exact wording after normalisation). */
export async function findSavedAnswers(tx: TransactionSql, userId: string, questions: string[]): Promise<Map<string, { id: string; answer: string }>> {
  const norms = [...new Set(questions.map(normalizeQuestion).filter(Boolean))];
  if (!norms.length) return new Map();
  const rows = await tx<{ id: string; question_norm: string; answer: string }[]>`
    select id, question_norm, answer from saved_answers where user_id = ${userId} and question_norm in ${tx(norms)}`;
  return new Map(rows.map((r) => [r.question_norm, { id: r.id, answer: decryptValue(r.answer) }]));
}

export async function listSavedAnswers(actor: Actor): Promise<SavedAnswerView[]> {
  const rows = await asUser(actor, (tx) => tx<{ id: string; question: string; answer: string; domain: string | null; use_count: number; updated_at: Date }[]>`
    select id, question, answer, domain, use_count, updated_at from saved_answers where user_id = ${actor.id} order by updated_at desc limit 500`);
  return rows.map((r) => ({ id: r.id, question: r.question, answer: decryptValue(r.answer), domain: r.domain, useCount: r.use_count, updatedAt: r.updated_at.toISOString() }));
}

export async function updateSavedAnswer(actor: Actor, id: string, answer: string) {
  const v = answer.trim();
  if (!v || v.length > 5000) throw badRequest("Answer must be 1–5000 characters");
  const rows = await asUser(actor, (tx) => tx`update saved_answers set answer = ${encryptValue(v)} where id = ${id} and user_id = ${actor.id} returning id`);
  if (!rows.length) throw notFound("Saved answer not found");
}

export async function deleteSavedAnswer(actor: Actor, id: string) {
  const rows = await asUser(actor, (tx) => tx`delete from saved_answers where id = ${id} and user_id = ${actor.id} returning id`);
  if (!rows.length) throw notFound("Saved answer not found");
}

// --- Learning from chat --------------------------------------------------------------------

export interface AbsorbResult {
  saved: Array<{ key: string; label: string; value: string; status: string }>;
  /** Sensitive facts (ID numbers, bank) are not saved from here. */
  skipped: string[];
}

export async function absorbMessage(actor: Actor, text: string, ip?: string): Promise<AbsorbResult> {
  const facts = extractChatFacts(text);
  const out: AbsorbResult = { saved: [], skipped: [] };
  if (!facts.length) return out;
  await asUser(actor, async (tx) => {
    for (const f of facts) {
      const def = getFieldDef(f.fieldKey);
      if (!def) continue;
      if (def.sensitivity !== "normal") {
        out.skipped.push(def.label.en);
        continue;
      }
      try {
        const r = await updateFieldTx(tx, actor, { fieldKey: f.fieldKey, value: f.value, confirmOverwrite: true }, { source: "chat", userConfirmed: true, confidence: 1, reason: "Told the assistant in the extension", ip });
        out.saved.push({ key: f.fieldKey, label: def.label.en, value: f.value, status: r.status });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        out.skipped.push(`${def.label.en} (${err.message})`);
      }
    }
  });
  return out;
}

/**
 * The user answered a form question in chat or the side panel. Profile field → profile
 * (validated, history kept); anything else → saved answers. Sensitive profile fields are
 * not saved from here (the dashboard's confirm flow handles them).
 */
export async function answerQuestion(
  actor: Actor,
  input: { question: string; answer: string; profileFieldKey?: string | null; kind?: string | null; domain?: string | null },
  ip?: string,
): Promise<{ savedTo: "profile" | "answers" | "none"; label: string; status?: string }> {
  const key = input.profileFieldKey && isCatalogKey(input.profileFieldKey) ? input.profileFieldKey : null;
  const def = key ? getFieldDef(key) : null;
  return asUser(actor, async (tx) => {
    if (def && key) {
      if (def.sensitivity !== "normal") return { savedTo: "none" as const, label: def.label.en };
      const r = await updateFieldTx(tx, actor, { fieldKey: key, value: input.answer, confirmOverwrite: true }, { source: "chat", userConfirmed: true, confidence: 1, reason: `Answered "${input.question.slice(0, 80)}" in the extension`, ip });
      return { savedTo: "profile" as const, label: def.label.en, status: r.status };
    }
    await saveAnswer(actor, { question: input.question, answer: input.answer, kind: input.kind, domain: input.domain }, tx);
    await audit({ actorId: actor.id, actorRole: actor.role, action: "agent.answer_saved", targetType: "saved_answer", subjectUserId: actor.id, ip, metadata: { domain: input.domain ?? null } }, tx);
    return { savedTo: "answers" as const, label: input.question.slice(0, 80) };
  });
}

// --- Answers to open questions -------------------------------------------------------------

const PRO_KEYS = [
  "employment.summary",
  "employment.skills",
  "employment.designation",
  "employment.company",
  "employment.experience_years",
  "education.highest_qualification",
  "education.post_graduation.course",
  "education.post_graduation.specialization",
  "education.graduation.course",
  "education.graduation.specialization",
] as const;

const g = globalThis as unknown as { __ufaAnswerGemini?: GeminiProvider | null };
function gemini(): GeminiProvider | null {
  if (g.__ufaAnswerGemini !== undefined) return g.__ufaAnswerGemini;
  const e = env();
  g.__ufaAnswerGemini = e.GEMINI_ENABLED && e.GEMINI_API_KEY ? new GeminiProvider({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL, baseUrl: e.GEMINI_BASE_URL }) : null;
  return g.__ufaAnswerGemini;
}

export interface DraftResult extends AnswerDraft {
  source: "gemini" | "template";
  /** Gemini could write a better answer if the user allows sharing their professional profile. */
  canAskConsent: boolean;
}

export async function draftAnswer(actor: Actor, input: { question: string; role?: string | null; maxWords?: number | null }): Promise<DraftResult> {
  const e = env();
  const { facts, cloudAi, sharing, usedToday } = await asUser(actor, async (tx) => {
    const rows = await tx<{ field_key: string; value: string; is_encrypted: boolean }[]>`
      select field_key, value, is_encrypted from profile_fields where user_id = ${actor.id} and deleted_at is null and field_key in ${tx([...PRO_KEYS])}`;
    const [p] = await tx<{ cloud_ai_enabled: boolean; ai_profile_sharing: boolean }[]>`select cloud_ai_enabled, ai_profile_sharing from profiles where user_id = ${actor.id}`;
    const [c] = await tx<{ n: number }[]>`
      select count(*)::int as n from ai_requests where user_id = ${actor.id} and operation = 'answer_question' and success and created_at >= date_trunc('day', now())`;
    const byKey = new Map(rows.map((r) => [r.field_key, readStored(r)]));
    return {
      facts: PRO_KEYS.filter((k) => byKey.has(k)).map((k) => ({ label: getFieldDef(k)!.label.en, value: redact(byKey.get(k)!).slice(0, 800) })),
      cloudAi: p?.cloud_ai_enabled ?? true,
      sharing: p?.ai_profile_sharing ?? false,
      usedToday: c!.n,
    };
  });
  const maxWords = input.maxWords ?? wordLimitOf(input.question);
  const base = { question: redact(input.question).slice(0, 1000), role: input.role?.slice(0, 120) ?? null, maxWords, facts };
  const provider = gemini();
  if (provider && cloudAi && sharing && facts.length && usedToday < e.COMPOSE_DAILY_LIMIT) {
    const started = Date.now();
    try {
      const r = await provider.answerQuestion(base);
      await record(actor, provider.model, Date.now() - started, true, r.usage);
      return { ...r.draft, source: "gemini", canAskConsent: false };
    } catch (err) {
      console.warn(`[ai] gemini answer_question failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      await record(actor, provider.model, Date.now() - started, false).catch(() => {});
    }
  }
  return { ...templateAnswer(base), source: "template", canAskConsent: Boolean(provider && cloudAi && !sharing && facts.length) };
}

async function record(actor: Actor, model: string, latencyMs: number, success: boolean, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, 'gemini', ${model}, 'answer_question', ${latencyMs}, ${success}, ${success ? null : "provider_error"}, false,
            ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
}

export async function setProfileSharing(actor: Actor, enabled: boolean, ip?: string) {
  await asUser(actor, async (tx) => {
    await tx`update profiles set ai_profile_sharing = ${enabled} where user_id = ${actor.id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: enabled ? "privacy.ai_profile_sharing_on" : "privacy.ai_profile_sharing_off", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip }, tx);
  });
  return { enabled };
}
