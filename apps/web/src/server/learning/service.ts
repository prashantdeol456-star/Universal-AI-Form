import "server-only";
import { NOT_A_PROFILE_FIELD, runLearning, type LearningRunResult } from "@ufa/ai";
import { normalizeLabel, type FillResult } from "@ufa/form-engine";
import { getFieldDef, isCatalogKey } from "@ufa/shared";
import { redact } from "@ufa/security";
import { audit } from "../audit";
import { asUser, db, type Actor } from "../db";
import { env } from "../env";
import { notFound } from "../http";
import { localAiProvider } from "../mapping/service";
import { syncSharedLabelEmbeddings } from "../mapping/vector-store";

/**
 * Learning engine glue (spec §37–41, phase 9).
 *
 * 1. Every user-verified mapping becomes a learning example — structure only
 *    (label, section, input type, options), never a value. Users can opt out.
 * 2. A successful fill confirmed by the user strengthens their own mapping.
 * 3. A background job (`runLearning`) promotes what *several different users*
 *    agree on to WEBSITE and GLOBAL knowledge, and demotes what no longer holds.
 */

export type ExampleSource = "USER_VERIFIED" | "GEMINI_USER_VERIFIED" | "LOCAL_AI_USER_VERIFIED" | "SUCCESSFUL_APPLICATION" | "USER_CORRECTION";

export interface ExampleInput {
  source: ExampleSource;
  domain: string;
  label: string;
  fieldSignature: string | null;
  section?: string | null;
  kind?: string | null;
  options?: string[];
  language?: string | null;
  key: string;
}

async function contributes(userId: string): Promise<boolean> {
  const [p] = await db().system<{ learning_contribution_enabled: boolean }[]>`
    select learning_contribution_enabled from profiles where user_id = ${userId}`;
  return p?.learning_contribution_enabled ?? true;
}

/** Writes examples (system pool: the runtime role cannot insert them). Duplicates within 30 days are skipped. */
export async function recordExamples(userId: string, items: ExampleInput[]): Promise<number> {
  if (!items.length || !env().LEARNING_ENABLED || !(await contributes(userId))) return 0;
  const sql = db().system;
  let n = 0;
  for (const it of items) {
    if (it.key !== NOT_A_PROFILE_FIELD && !isCatalogKey(it.key)) continue;
    const normalized = normalizeLabel(it.label).slice(0, 200);
    if (!normalized) continue;
    const [dup] = await sql`
      select 1 from learning_examples
       where contributor_user_id = ${userId} and domain = ${it.domain} and normalized_label = ${normalized}
         and profile_field_key = ${it.key} and source = ${it.source} and created_at > now() - interval '30 days'
       limit 1`;
    if (dup) continue;
    const context = {
      section: it.section?.slice(0, 200) ?? null,
      type: it.kind ?? null,
      options: (it.options ?? []).slice(0, 20).map((o) => o.slice(0, 60)),
    };
    await sql`
      insert into learning_examples (source, contributor_user_id, domain, field_label, field_context, language, profile_field_key, field_signature, normalized_label)
      values (${it.source}, ${userId}, ${it.domain}, ${it.label.slice(0, 200)}, ${sql.json(context)}, ${it.language === "hi" || it.language === "mixed" ? "hi" : "en"},
              ${it.key}, ${it.fieldSignature}, ${normalized})`;
    n++;
  }
  if (n) kickLearning();
  return n;
}

export function exampleSourceForFeedback(confirmed: boolean, provider: string | null | undefined): ExampleSource {
  if (!confirmed) return "USER_CORRECTION";
  if (provider === "gemini") return "GEMINI_USER_VERIFIED";
  if (provider === "local_ai" || provider === "local") return "LOCAL_AI_USER_VERIFIED";
  return "USER_VERIFIED";
}

/**
 * The user confirmed the preview and these fields were filled: the user's own
 * mapping for each becomes verified (+1 success), and a SUCCESSFUL_APPLICATION example is recorded.
 */
export async function learnFromFill(actor: Actor, applicationId: string, results: FillResult[]) {
  const filled = results.filter((r) => r.status === "filled").map((r) => r.fieldId);
  if (!filled.length) return;
  const rows = await asUser(actor, async (tx) => {
    const fields = await tx<{ domain: string; website_field_label: string; field_signature: string; section: string | null; field_type: string | null; language: string | null; profile_field_key: string }[]>`
      select a.domain, f.website_field_label, f.field_signature, f.section, f.field_type, f.language, f.profile_field_key
        from application_fields f join applications a on a.id = f.application_id
       where f.application_id = ${applicationId} and a.customer_id = ${actor.id}
         and f.source = 'profile' and f.profile_field_key is not null and f.field_signature is not null
         and f.field_ref in ${tx(filled)}`;
    for (const f of fields) {
      const normalized = normalizeLabel(f.website_field_label).slice(0, 200);
      await tx`
        insert into form_mappings (scope, user_id, domain, field_signature, field_label, normalized_label, language, profile_field_key,
                                   verified, verification_source, success_count, failure_count, last_verified_at)
        values ('USER', ${actor.id}, ${f.domain}, ${f.field_signature}, ${f.website_field_label.slice(0, 200)}, ${normalized},
                ${f.language === "en" ? "en" : "hi"}, ${f.profile_field_key}, true, 'application', 1, 0, now())
        on conflict (scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(domain, ''), field_signature, profile_field_key)
        do update set success_count = form_mappings.success_count + 1, verified = true, last_verified_at = now()`;
    }
    return fields;
  });
  await recordExamples(
    actor.id,
    rows.map((f) => ({
      source: "SUCCESSFUL_APPLICATION" as const,
      domain: f.domain,
      label: f.website_field_label,
      fieldSignature: f.field_signature,
      section: f.section,
      kind: f.field_type,
      language: f.language,
      key: f.profile_field_key,
    })),
  );
}

// --- background promotion job -------------------------------------------------------------

const g = globalThis as unknown as { __ufaLearning?: { timer?: NodeJS.Timeout; running: boolean; pending?: NodeJS.Timeout } };

async function runOnce(): Promise<LearningRunResult | null> {
  const state = (g.__ufaLearning ??= { running: false });
  if (state.running) return null;
  state.running = true;
  try {
    const e = env();
    const r = await runLearning(db().system, {
      websiteMinUsers: e.LEARNING_WEBSITE_MIN_USERS,
      websiteMinAgreement: 0.8,
      globalMinUsers: e.LEARNING_GLOBAL_MIN_USERS,
      globalMinDomains: 2,
      globalMinAgreement: 0.9,
    });
    if (!r.skipped && (r.websitePromoted || r.globalPromoted || r.demoted)) {
      console.info(`[learning] ${r.votes} votes → ${r.websitePromoted} website, ${r.globalPromoted} global patterns, ${r.demoted} demoted`);
    }
    // Keep the pgvector label index in step with newly shared knowledge (no-op without pgvector).
    const provider = localAiProvider();
    if (!r.skipped && provider && e.LOCAL_AI_EMBED_MODEL) {
      const n = await syncSharedLabelEmbeddings(provider, e.LOCAL_AI_EMBED_MODEL);
      if (n) console.info(`[vectors] embedded ${n} shared labels`);
    }
    return r;
  } catch (err) {
    console.error(`[learning] run failed: ${redact(String(err))}`);
    return null;
  } finally {
    state.running = false;
  }
}

export function startLearningScheduler() {
  const e = env();
  if (!e.LEARNING_ENABLED || g.__ufaLearning?.timer) return;
  const state = (g.__ufaLearning ??= { running: false });
  state.timer = setInterval(() => void runOnce(), e.LEARNING_INTERVAL_MINUTES * 60_000);
  state.timer.unref?.();
  setTimeout(() => void runOnce(), 30_000).unref?.();
  console.info(`[learning] promotion job every ${e.LEARNING_INTERVAL_MINUTES} min`);
}

/** New evidence arrived: run soon (debounced) instead of waiting for the next interval. */
export function kickLearning(delayMs = 60_000) {
  if (!env().LEARNING_ENABLED) return;
  const state = (g.__ufaLearning ??= { running: false });
  if (state.pending) return;
  state.pending = setTimeout(() => {
    state.pending = undefined;
    void runOnce();
  }, delayMs);
  state.pending.unref?.();
}

// --- user-facing: what the assistant learned from me -------------------------------------

export interface LearnedMapping {
  id: string;
  domain: string | null;
  label: string;
  profileFieldKey: string;
  profileFieldLabel: string;
  verified: boolean;
  successCount: number;
  failureCount: number;
  source: string | null;
  updatedAt: string;
}

export interface LearningOverview {
  contributionEnabled: boolean;
  mappings: LearnedMapping[];
  stats: { verifiedMappings: number; corrections: number; examples: number; websites: number };
  community: { websitePatterns: number; globalPatterns: number; lastRunAt: string | null };
}

export async function learningOverview(actor: Actor): Promise<LearningOverview> {
  const mine = await asUser(actor, async (tx) => {
    const [p] = await tx<{ learning_contribution_enabled: boolean }[]>`select learning_contribution_enabled from profiles where user_id = ${actor.id}`;
    const rows = await tx<{ id: string; domain: string | null; field_label: string; profile_field_key: string; verified: boolean; success_count: number; failure_count: number; verification_source: string | null; updated_at: Date }[]>`
      select id, domain, field_label, profile_field_key, verified, success_count, failure_count, verification_source, updated_at
        from form_mappings where scope = 'USER' and user_id = ${actor.id}
       order by updated_at desc limit 500`;
    const [c] = await tx<{ n: number }[]>`select count(*)::int as n from learning_corrections where user_id = ${actor.id}`;
    const [ex] = await tx<{ n: number }[]>`select count(*)::int as n from learning_examples where contributor_user_id = ${actor.id} and status <> 'REMOVED'`;
    return { enabled: p?.learning_contribution_enabled ?? true, rows, corrections: c!.n, examples: ex!.n };
  });
  // Shared knowledge counts (no user data): system pool.
  const [community] = await db().system<{ website: number; global: number }[]>`
    select count(*) filter (where scope = 'WEBSITE')::int as website, count(*) filter (where scope = 'GLOBAL')::int as global
      from form_mappings where scope in ('WEBSITE', 'GLOBAL') and verified`;
  const [run] = await db().system<{ finished_at: Date | null }[]>`
    select finished_at from learning_runs where finished_at is not null and error is null order by finished_at desc limit 1`;

  const mappings = mine.rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    label: r.field_label,
    profileFieldKey: r.profile_field_key,
    profileFieldLabel: r.profile_field_key === NOT_A_PROFILE_FIELD ? "Not a profile field" : (getFieldDef(r.profile_field_key)?.label.en ?? r.profile_field_key),
    verified: r.verified,
    successCount: r.success_count,
    failureCount: r.failure_count,
    source: r.verification_source,
    updatedAt: r.updated_at.toISOString(),
  }));
  return {
    contributionEnabled: mine.enabled,
    mappings,
    stats: {
      verifiedMappings: mappings.filter((m) => m.verified && m.successCount > m.failureCount).length,
      corrections: mine.corrections,
      examples: mine.examples,
      websites: new Set(mappings.map((m) => m.domain).filter(Boolean)).size,
    },
    community: { websitePatterns: community?.website ?? 0, globalPatterns: community?.global ?? 0, lastRunAt: run?.finished_at?.toISOString() ?? null },
  };
}

/** Forget one learned mapping (the next visit asks again). Shared patterns are recalculated on the next run. */
export async function forgetMapping(actor: Actor, id: string) {
  await asUser(actor, async (tx) => {
    const rows = await tx`delete from form_mappings where id = ${id} and scope = 'USER' and user_id = ${actor.id} returning id`;
    if (!rows.length) throw notFound("Mapping not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "learning.mapping_forgotten", targetType: "form_mapping", targetId: id, subjectUserId: actor.id }, tx);
  });
  kickLearning();
  return { removed: true as const };
}

export async function setContribution(actor: Actor, enabled: boolean, ip?: string) {
  await asUser(actor, async (tx) => {
    await tx`update profiles set learning_contribution_enabled = ${enabled} where user_id = ${actor.id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: enabled ? "learning.contribution_enabled" : "learning.contribution_disabled", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip }, tx);
  });
  kickLearning(5_000);
  return { contributionEnabled: enabled };
}

/**
 * Stops contributing and withdraws everything contributed so far: examples are
 * marked REMOVED (kept out of every future dataset), and shared patterns that
 * relied on this user are demoted on the next run.
 */
export async function withdrawContributions(actor: Actor, ip?: string) {
  await setContribution(actor, false, ip);
  const removed = await db().system`
    update learning_examples set status = 'REMOVED' where contributor_user_id = ${actor.id} and status <> 'REMOVED' returning id`;
  await audit({ actorId: actor.id, actorRole: actor.role, action: "learning.contributions_withdrawn", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip, metadata: { examples: removed.length } });
  return { withdrawn: removed.length };
}
