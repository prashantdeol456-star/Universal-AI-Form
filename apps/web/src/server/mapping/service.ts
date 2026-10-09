import "server-only";
import {
  AIOrchestrator,
  GeminiProvider,
  LocalAIProvider,
  NOT_A_PROFILE_FIELD,
  type AiCallInfo,
  type AnswerCache,
  type Decision,
  type DecisionReason,
  type EvidenceSource,
  type GeminiStatus,
  type KnowledgeHit,
  type MapFormResult,
  type ProfileValue,
} from "@ufa/ai";
import { normalizeLabel, type FormSnapshot } from "@ufa/form-engine";
import { cafePermissionForField, formatFieldValue, getFieldDef, isCatalogKey, maskValue } from "@ufa/shared";
import { audit } from "../audit";
import type { CafeContext } from "../cafe/context";
import { redact } from "@ufa/security";
import type { TransactionSql } from "@ufa/db";
import { asUser, db, type Actor } from "../db";
import { readStored } from "../documents/conflicts";
import { env } from "../env";
import { badRequest } from "../http";
import { previousApplications } from "../applications/history";
import { detectFormChange, recordFormSignature, type FormChangeView } from "../forms/service";
import { exampleSourceForFeedback, recordExamples } from "../learning/service";
import { findSavedForm } from "../saved-forms/service";
import { pgVectorStore } from "./vector-store";
import { findSavedAnswers, normalizeQuestion } from "../agent/service";

/**
 * Maps a detected form to the user's profile (spec §22–30, §101). Thin glue:
 * loads the profile and knowledge base under RLS, asks the AIOrchestrator
 * (rules → KB → local AI → Gemini), records AI telemetry and usage, and shapes
 * the result for the extension.
 */

const g = globalThis as unknown as { __ufaOrchestrator?: AIOrchestrator };

/** Shared fallback-answer cache in PostgreSQL (keys contain structure only, no user data). */
const answerCache = (provider: string, model: string): AnswerCache => ({
  async get(keys) {
    if (!keys.length) return new Map();
    const sql = db().system;
    const rows = await sql<{ cache_key: string; profile_field_key: string | null; confidence: string | null }[]>`
      update ai_mapping_cache set hits = hits + 1
       where cache_key in ${sql(keys)} and provider = ${provider} and model = ${model} and expires_at > now()
       returning cache_key, profile_field_key, confidence`;
    return new Map(rows.map((r) => [r.cache_key, { profileField: r.profile_field_key, confidence: Number(r.confidence ?? 0) }]));
  },
  async set(entries) {
    const sql = db().system;
    const ttl = env().AI_CACHE_TTL_DAYS;
    for (const e of entries) {
      await sql`
        insert into ai_mapping_cache (cache_key, provider, model, profile_field_key, confidence, expires_at)
        values (${e.key.slice(0, 1000)}, ${provider}, ${model}, ${e.profileField}, ${e.confidence}, now() + make_interval(days => ${ttl}))
        on conflict (cache_key) do update
           set provider = excluded.provider, model = excluded.model, profile_field_key = excluded.profile_field_key,
               confidence = excluded.confidence, expires_at = excluded.expires_at`;
    }
  },
});

function orchestrator(): AIOrchestrator {
  if (g.__ufaOrchestrator) return g.__ufaOrchestrator;
  const e = env();
  const localAi = e.LOCAL_AI_ENABLED
    ? new LocalAIProvider({ baseUrl: e.LOCAL_AI_BASE_URL, model: e.LOCAL_AI_MODEL, embedModel: e.LOCAL_AI_EMBED_MODEL || undefined, apiKey: e.LOCAL_AI_API_KEY, timeoutMs: 60_000 })
    : null;
  // The Gemini key is read only here, on the server (spec §55); it is never sent to the extension.
  const gemini =
    e.GEMINI_ENABLED && e.GEMINI_API_KEY
      ? new GeminiProvider({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL, baseUrl: e.GEMINI_BASE_URL, batchSize: e.GEMINI_MAX_FIELDS_PER_REQUEST })
      : null;
  if (e.GEMINI_ENABLED && !e.GEMINI_API_KEY) console.warn("[ai] GEMINI_ENABLED is true but GEMINI_API_KEY is empty: Gemini fallback is off");
  g.__ufaOrchestrator = new AIOrchestrator({
    localAi,
    gemini,
    geminiCache: gemini ? answerCache("gemini", gemini.model) : null,
    semantic: Boolean(localAi && e.LOCAL_AI_EMBED_MODEL),
    // Shared learned labels in pgvector (optional; falls back to in-process search).
    labelStore: localAi && e.LOCAL_AI_EMBED_MODEL ? pgVectorStore(e.LOCAL_AI_EMBED_MODEL) : null,
    thresholds: { auto: e.AI_CONFIDENCE_THRESHOLD, review: e.AI_FALLBACK_THRESHOLD },
  });
  return g.__ufaOrchestrator;
}

/** The configured local provider (for background jobs such as embedding sync), or null. */
export function localAiProvider(): LocalAIProvider | null {
  const e = env();
  return e.LOCAL_AI_ENABLED && e.LOCAL_AI_EMBED_MODEL
    ? new LocalAIProvider({ baseUrl: e.LOCAL_AI_BASE_URL, model: e.LOCAL_AI_MODEL, embedModel: e.LOCAL_AI_EMBED_MODEL, apiKey: e.LOCAL_AI_API_KEY, timeoutMs: 60_000 })
    : null;
}

export interface FieldMappingView {
  fieldId: string;
  profileFieldKey: string | null;
  profileFieldLabel: string | null;
  profileFieldLabelHi: string | null;
  /** Value that would be used (masked when sensitive). Null when missing. */
  value: string | null;
  valueVerified: boolean;
  optionMatch: string | null;
  confidence: number;
  decision: Decision;
  reason: DecisionReason | "not_shared";
  sources: EvidenceSource[];
  candidates: Array<{ fieldKey: string; label: string; confidence: number }>;
  /** The user answered this exact question before (not a profile field, or no profile value). */
  savedAnswer: string | null;
}

export interface MapResultView {
  formSignatureId: string;
  seenBefore: boolean;
  firstSeenAt: string;
  fields: FieldMappingView[];
  stats: MapFormResult["stats"];
  engine: {
    localAi: boolean;
    semantic: boolean;
    gemini: GeminiStatus;
    geminiFields: number;
    /** Fields Gemini was asked about (or answered from cache), whether or not it was sure. */
    geminiAsked: number;
    /** False when the user turned cloud AI off. */
    cloudAiAllowed: boolean;
  };
  /** The user's earlier filled/submitted applications for this form (newest first). */
  previousApplications: Array<{ id: string; status: string; applicationNumber: string | null; createdAt: string; submittedAt: string | null }>;
  /** Set when this page is in the user's saved forms. */
  savedForm: { id: string; name: string } | null;
  /** The form changed since the user last applied here (site-specific knowledge is then double-checked). */
  formChange: FormChangeView | null;
  /** Set when an operator is filling for a café customer. */
  cafe: { sessionId: string; customerName: string; expiresAt: string; permissions: string[] } | null;
}

async function loadProfile(tx: TransactionSql, userId: string): Promise<Map<string, ProfileValue>> {
  const rows = await tx<{ field_key: string; value: string; is_encrypted: boolean; verified: boolean }[]>`
    select field_key, value, is_encrypted, verified from profile_fields where user_id = ${userId} and deleted_at is null`;
  return new Map(
    rows
      .filter((r) => isCatalogKey(r.field_key))
      .map((r) => [r.field_key, { value: readStored(r), verified: r.verified, sensitive: (getFieldDef(r.field_key)?.sensitivity ?? "normal") !== "normal" }]),
  );
}

interface KbRow {
  scope: "WEBSITE" | "USER" | "GLOBAL";
  domain: string | null;
  field_signature: string;
  normalized_label: string;
  profile_field_key: string;
  verified: boolean;
  success_count: number;
  failure_count: number;
}

/** Knowledge-base hits per field (spec §24 priority is applied by evidence weights). */
async function loadKnowledge(tx: TransactionSql, userId: string, snapshot: FormSnapshot): Promise<Map<string, KnowledgeHit[]>> {
  const sigs = [...new Set(snapshot.fields.map((f) => f.signature))];
  const labels = [...new Set(snapshot.fields.map((f) => normalizeLabel(f.label)).filter(Boolean))];
  if (!sigs.length) return new Map();
  const rows = await tx<KbRow[]>`
    select scope, domain, field_signature, normalized_label, profile_field_key, verified, success_count, failure_count
      from form_mappings
     where (scope = 'WEBSITE' and domain = ${snapshot.domain} and field_signature in ${tx(sigs)})
        or (scope = 'USER' and user_id = ${userId} and (field_signature in ${tx(sigs)} or normalized_label in ${tx(labels)}))
        or (scope = 'GLOBAL' and verified and normalized_label in ${tx(labels)})`;
  const out = new Map<string, KnowledgeHit[]>();
  for (const f of snapshot.fields) {
    const label = normalizeLabel(f.label);
    const hits: KnowledgeHit[] = [];
    for (const r of rows) {
      const sameField = r.field_signature === f.signature && r.domain === snapshot.domain;
      let scope: KnowledgeHit["scope"] | null = null;
      if (r.scope === "WEBSITE" && sameField) scope = "WEBSITE";
      else if (r.scope === "USER" && sameField) scope = "USER";
      else if (r.scope === "USER" && r.normalized_label === label) scope = "USER_ANY_SITE";
      else if (r.scope === "GLOBAL" && r.normalized_label === label) scope = "GLOBAL";
      if (!scope) continue;
      hits.push({
        scope,
        fieldKey: r.profile_field_key === NOT_A_PROFILE_FIELD ? null : r.profile_field_key,
        verified: r.verified,
        successCount: r.success_count,
        failureCount: r.failure_count,
      });
    }
    if (hits.length) out.set(f.id, hits);
  }
  return out;
}

/** Records one AI call: telemetry row (no content), daily usage, and per-field fallback suggestions. */
async function recordAiCall(actor: Actor, snapshot: FormSnapshot, c: AiCallInfo) {
  const confs = c.suggestions?.filter((s) => s.profileField).map((s) => s.confidence) ?? [];
  const avg = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : null;
  await asUser(actor, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, confidence, fallback_used, input_tokens, output_tokens, items)
      values (${actor.id}, ${c.provider}, ${c.model}, ${c.operation}, ${c.latencyMs}, ${c.success}, ${c.success ? null : "provider_error"},
              ${avg}, ${Boolean(c.fallback)}, ${c.usage?.inputTokens ?? null}, ${c.usage?.outputTokens ?? null}, ${c.items})
      returning id`;
    if (c.fallback && c.suggestions?.length) {
      const sigById = new Map(snapshot.fields.map((f) => [f.id, f.signature]));
      for (const s of c.suggestions) {
        await tx`
          insert into ai_field_suggestions (user_id, ai_request_id, provider, model, domain, field_signature, suggested_key, confidence)
          values (${actor.id}, ${row!.id}, ${c.provider}, ${c.model}, ${snapshot.domain}, ${sigById.get(s.fieldId) ?? "00000000"}, ${s.profileField}, ${Math.min(s.confidence, 1)})`;
      }
    }
  });
  // Daily usage per provider (spec §69): the runtime role may only read it, so the system pool writes.
  await db().system`
    insert into ai_usage (user_id, period, provider, request_count, input_tokens, output_tokens)
    values (${actor.id}, current_date, ${c.provider}, 1, ${c.usage?.inputTokens ?? 0}, ${c.usage?.outputTokens ?? 0})
    on conflict (user_id, period, provider) do update
       set request_count = ai_usage.request_count + 1,
           input_tokens = ai_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_usage.output_tokens + excluded.output_tokens`;
}

/**
 * `cafe` set: an operator fills for a customer. The customer's profile is read
 * under the operator's RLS (only the categories the customer granted are
 * visible), the customer's cloud-AI choice applies, and the access is audited
 * on the customer's access log.
 */
export async function mapFormForUser(actor: Actor, snapshot: FormSnapshot, cafe?: CafeContext): Promise<MapResultView> {
  const recorded = await recordFormSignature(snapshot);
  const e = env();
  const subjectId = cafe?.customerId ?? actor.id;
  const customerPref = cafe
    ? (await db().system<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${cafe.customerId}`)[0]
    : undefined;
  const { profile, knowledge, cloudAiAllowed, geminiFieldsToday, formChange, savedAnswers } = await asUser(actor, async (tx) => {
    const [own] = cafe ? [undefined] : await tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${actor.id}`;
    const pref = cafe ? customerPref : own;
    const [used] = (await tx`
      select coalesce(sum(items), 0)::int as n from ai_requests
       where user_id = ${actor.id} and provider = 'gemini' and success and created_at >= date_trunc('day', now())`) as unknown as [{ n: number }];
    const change = cafe ? null : await detectFormChange(tx, actor.id, snapshot, recorded.formSignatureId);
    const kb = await loadKnowledge(tx, actor.id, snapshot);
    // Knowledge about this exact website field is weighed less until the user confirms it again.
    if (change) for (const hits of kb.values()) for (const h of hits) if (h.scope === "WEBSITE" || h.scope === "USER") h.stale = true;
    return {
      profile: await loadProfile(tx, subjectId),
      knowledge: kb,
      cloudAiAllowed: pref?.cloud_ai_enabled ?? true,
      geminiFieldsToday: used.n,
      formChange: change,
      // Own answers only: never offered in café mode.
      savedAnswers: cafe ? new Map<string, { id: string; answer: string }>() : await findSavedAnswers(tx, actor.id, snapshot.fields.map((f) => f.label)),
    };
  });

  const calls: AiCallInfo[] = [];
  const result = await orchestrator().mapForm({
    fields: snapshot.fields,
    profile,
    knowledge,
    allowCloudAi: cloudAiAllowed,
    geminiBudget: Math.max(0, Math.min(e.GEMINI_MAX_FIELDS_PER_REQUEST, e.GEMINI_DAILY_FIELD_LIMIT - geminiFieldsToday)),
    onAiCall: (c) => calls.push(c),
  });

  for (const c of calls) {
    if (!c.success) console.warn(`[ai] ${c.provider} ${c.operation} failed: ${redact(c.error ?? "")}`);
    await recordAiCall(actor, snapshot, c).catch((err) => console.error(`[ai] telemetry failed: ${redact(String(err))}`));
  }

  const label = (key: string) => getFieldDef(key)?.label;
  const labelById = new Map(snapshot.fields.map((f) => [f.id, f.label]));
  const [previous, saved] = cafe
    ? [[], null]
    : await Promise.all([
        previousApplications(actor, recorded.formSignatureId, snapshot.url),
        snapshot.url ? findSavedForm(actor, snapshot.url).catch(() => null) : Promise.resolve(null),
      ]);
  if (cafe) {
    await audit({
      actorId: actor.id, actorRole: actor.role, action: "cafe.profile_used", targetType: "cafe_session", targetId: cafe.sessionId,
      subjectUserId: cafe.customerId, cafeId: cafe.cafeId, metadata: { domain: snapshot.domain, fields: profile.size },
    });
  }
  return {
    ...recorded,
    cafe: cafe ? { sessionId: cafe.sessionId, customerName: cafe.customerName, expiresAt: cafe.expiresAt, permissions: cafe.permissions } : null,
    previousApplications: previous,
    savedForm: saved,
    formChange,
    stats: result.stats,
    engine: {
      localAi: result.localAiUsed,
      semantic: result.semanticUsed,
      gemini: result.gemini.status,
      geminiFields: result.gemini.fieldsSuggested,
      geminiAsked: result.gemini.fieldsSent + result.gemini.fieldsFromCache,
      cloudAiAllowed,
    },
    fields: result.mappings.map((m) => {
      const key = m.profileFieldKey;
      const pv = key ? profile.get(key) : undefined;
      return {
        fieldId: m.fieldId,
        profileFieldKey: key,
        profileFieldLabel: key ? label(key)?.en ?? key : null,
        profileFieldLabelHi: key ? label(key)?.hi ?? null : null,
        value: pv ? (pv.sensitive ? maskValue(pv.value) : formatFieldValue(key!, pv.value)) : null,
        valueVerified: pv?.verified ?? false,
        optionMatch: m.optionMatch,
        confidence: m.confidence,
        decision: m.decision,
        // In café mode a missing value may simply not be shared by the customer.
        reason: cafe && key && !pv && !cafe.permissions.includes(cafePermissionForField(key) ?? ("bank" as never)) ? "not_shared" : m.reason,
        sources: [...new Set(m.evidence.filter((ev) => ev.weight > 0).map((ev) => ev.source))],
        candidates: m.candidates.map((c) => ({ ...c, label: label(c.fieldKey)?.en ?? c.fieldKey })),
        savedAnswer: pv ? null : savedAnswers.get(normalizeQuestion(labelById.get(m.fieldId) ?? ""))?.answer ?? null,
      };
    }),
  };
}

export interface MappingFeedback {
  domain: string;
  field: { signature: string; label: string; language: "en" | "hi" | "mixed"; section?: string | null; kind?: string | null; options?: string[] };
  suggestedKey: string | null;
  /** Correct profile field, or "__none__" for "this is not a profile field". */
  correctKey: string;
  provider?: string | null;
}

/**
 * The user confirmed or corrected a mapping in the side panel. Stored as the
 * user's own verified mapping (used immediately next time); a correction also
 * records failure on the wrong mapping and a learning_corrections row (spec §33).
 * If the suggestion came from the AI fallback, its outcome is recorded too (spec §30).
 */
export async function recordMappingFeedback(actor: Actor, fb: MappingFeedback): Promise<{ saved: true }> {
  if (fb.correctKey !== NOT_A_PROFILE_FIELD && !isCatalogKey(fb.correctKey)) throw badRequest("Unknown profile field");
  if (fb.suggestedKey && !isCatalogKey(fb.suggestedKey)) throw badRequest("Unknown suggested field");
  const normalized = normalizeLabel(fb.field.label).slice(0, 200);
  const lang = fb.field.language === "mixed" ? "hi" : fb.field.language;

  const suggProvider = await asUser(actor, async (tx) => {
    const upsert = (key: string, success: number, failure: number, verified: boolean) => tx`
      insert into form_mappings (scope, user_id, domain, field_signature, field_label, normalized_label, language, profile_field_key,
                                 verified, verification_source, success_count, failure_count, last_verified_at)
      values ('USER', ${actor.id}, ${fb.domain}, ${fb.field.signature}, ${fb.field.label.slice(0, 200)}, ${normalized}, ${lang}, ${key},
              ${verified}, 'user', ${success}, ${failure}, ${verified ? new Date() : null})
      on conflict (scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(domain, ''), field_signature, profile_field_key)
      do update set success_count = form_mappings.success_count + excluded.success_count,
                    failure_count = form_mappings.failure_count + excluded.failure_count,
                    verified = form_mappings.verified or excluded.verified,
                    last_verified_at = coalesce(excluded.last_verified_at, form_mappings.last_verified_at),
                    field_label = excluded.field_label`;

    await upsert(fb.correctKey, 1, 0, true);

    // Outcome of an AI fallback suggestion for this field, if there is an open one.
    const [sugg] = await tx<{ id: string; ai_request_id: string | null; suggested_key: string | null; provider: string }[]>`
      select id, ai_request_id, suggested_key, provider from ai_field_suggestions
       where user_id = ${actor.id} and domain = ${fb.domain} and field_signature = ${fb.field.signature} and resolved_at is null
       order by created_at desc limit 1`;
    if (sugg) {
      const confirmed = sugg.suggested_key === fb.correctKey;
      await tx`update ai_field_suggestions set user_confirmed = ${confirmed}, user_corrected = ${!confirmed}, final_key = ${fb.correctKey}, resolved_at = now()
                where id = ${sugg.id}`;
      if (sugg.ai_request_id) {
        await tx`update ai_requests set user_confirmed = ${confirmed}, user_corrected = ${!confirmed} where id = ${sugg.ai_request_id}`;
      }
    }

    if (fb.suggestedKey && fb.suggestedKey !== fb.correctKey) {
      await upsert(fb.suggestedKey, 0, 1, false);
      await tx`
        insert into learning_corrections (user_id, domain, field_label, original_mapping, correct_mapping, original_provider)
        values (${actor.id}, ${fb.domain}, ${fb.field.label.slice(0, 200)}, ${fb.suggestedKey}, ${fb.correctKey},
                ${fb.provider ?? (sugg && sugg.suggested_key === fb.suggestedKey ? sugg.provider : "rules")})`;
    }
    return sugg && sugg.suggested_key === fb.suggestedKey ? sugg.provider : null;
  });

  // Structure-only learning example (no values); skipped if the user opted out.
  await recordExamples(actor.id, [
    {
      source: exampleSourceForFeedback(fb.correctKey === fb.suggestedKey, fb.provider ?? suggProvider),
      domain: fb.domain,
      label: fb.field.label,
      fieldSignature: fb.field.signature,
      section: fb.field.section,
      kind: fb.field.kind,
      options: fb.field.options,
      language: fb.field.language,
      key: fb.correctKey,
    },
  ]).catch((err) => console.error(`[learning] ${redact(String(err))}`));
  return { saved: true };
}
