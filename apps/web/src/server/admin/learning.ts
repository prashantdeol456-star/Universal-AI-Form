import "server-only";
import { NOT_A_PROFILE_FIELD } from "@ufa/ai";
import { getFieldDef, isCatalogKey } from "@ufa/shared";
import { audit } from "../audit";
import { db, type Actor } from "../db";
import { badRequest, notFound } from "../http";
import { kickLearning } from "../learning/service";
import { assertAdmin } from "./guard";

/**
 * Review of learning examples (phase 9 data) before it may train a model, and
 * oversight of shared knowledge. Examples hold structure only (label, section,
 * type, option names, target key); contributors are shown as counts, never names.
 */

export interface ReviewGroup {
  normalizedLabel: string;
  key: string;
  keyLabel: string;
  sampleLabel: string;
  sections: string[];
  languages: string[];
  contributors: number;
  domains: number;
  examples: number;
  sources: string[];
  /** Other keys people gave the same label (a hint that the label is ambiguous). */
  conflicts: Array<{ key: string; contributors: number }>;
}

export async function reviewQueue(actor: Actor, f: { q?: string; minContributors?: number; limit?: number } = {}): Promise<{ groups: ReviewGroup[]; totalPending: number }> {
  assertAdmin(actor, "admin:learning_manage");
  const sql = db().system;
  const like = f.q?.trim() ? `%${f.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await sql<{ normalized_label: string; profile_field_key: string; sample: string; sections: string[]; languages: string[]; contributors: number; domains: number; n: number; sources: string[] }[]>`
    select e.normalized_label, e.profile_field_key,
           min(e.field_label) as sample,
           array_remove(array_agg(distinct e.field_context->>'section'), null) as sections,
           array_agg(distinct e.language) as languages,
           count(distinct e.contributor_user_id)::int as contributors,
           count(distinct e.domain)::int as domains,
           count(*)::int as n,
           array_agg(distinct e.source) as sources
      from learning_examples e
     where e.status = 'PENDING' and e.normalized_label is not null
       ${like ? sql`and (e.normalized_label like ${like} or e.profile_field_key like ${like})` : sql``}
     group by e.normalized_label, e.profile_field_key
    having count(distinct e.contributor_user_id) >= ${f.minContributors ?? 1}
     order by count(distinct e.contributor_user_id) desc, count(*) desc
     limit ${Math.min(f.limit ?? 100, 500)}`;
  const labels = [...new Set(rows.map((r) => r.normalized_label))];
  const others = labels.length
    ? await sql<{ normalized_label: string; profile_field_key: string; contributors: number }[]>`
        select normalized_label, profile_field_key, count(distinct contributor_user_id)::int as contributors
          from learning_examples where status in ('PENDING', 'APPROVED') and normalized_label in ${sql(labels)}
         group by 1, 2`
    : [];
  const [t] = await sql<{ n: number }[]>`select count(*)::int as n from learning_examples where status = 'PENDING'`;
  return {
    totalPending: t!.n,
    groups: rows.map((r) => ({
      normalizedLabel: r.normalized_label,
      key: r.profile_field_key,
      keyLabel: r.profile_field_key === NOT_A_PROFILE_FIELD ? "Not a profile field" : (getFieldDef(r.profile_field_key)?.label.en ?? r.profile_field_key),
      sampleLabel: r.sample,
      sections: r.sections.slice(0, 5),
      languages: r.languages,
      contributors: r.contributors,
      domains: r.domains,
      examples: r.n,
      sources: r.sources,
      conflicts: others
        .filter((o) => o.normalized_label === r.normalized_label && o.profile_field_key !== r.profile_field_key)
        .map((o) => ({ key: o.profile_field_key, contributors: o.contributors })),
    })),
  };
}

/** Approve or reject every pending example of one label → key pair at once. */
export async function reviewGroup(actor: Actor, input: { normalizedLabel: string; key: string; decision: "APPROVED" | "REJECTED"; note?: string | null }, ip?: string) {
  assertAdmin(actor, "admin:learning_manage");
  if (input.key !== NOT_A_PROFILE_FIELD && !isCatalogKey(input.key)) throw badRequest("Unknown profile field");
  if (input.decision === "REJECTED" && !input.note?.trim()) throw badRequest("Say why it is rejected (kept with the examples)");
  const rows = await db().system`
    update learning_examples set status = ${input.decision}, reviewed_by = ${actor.id}, reviewed_at = now(), review_note = ${input.note?.trim().slice(0, 300) || null}
     where status = 'PENDING' and normalized_label = ${input.normalizedLabel} and profile_field_key = ${input.key}
    returning id`;
  if (!rows.length) throw notFound("Nothing pending for this label");
  await audit({ actorId: actor.id, actorRole: actor.role, action: `admin.examples_${input.decision.toLowerCase()}`, targetType: "learning_examples", ip, metadata: { label: input.normalizedLabel.slice(0, 100), key: input.key, count: rows.length } });
  return { updated: rows.length };
}

export interface SharedPattern {
  id: string;
  scope: "WEBSITE" | "GLOBAL";
  domain: string | null;
  label: string;
  key: string;
  keyLabel: string;
  verified: boolean;
  source: string | null;
  support: number;
  against: number;
  lastVerifiedAt: string | null;
}

export async function sharedPatterns(actor: Actor, f: { q?: string; scope?: "WEBSITE" | "GLOBAL" } = {}): Promise<SharedPattern[]> {
  assertAdmin(actor, "admin:learning_manage");
  const sql = db().system;
  const like = f.q?.trim() ? `%${f.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await sql<{ id: string; scope: "WEBSITE" | "GLOBAL"; domain: string | null; field_label: string; profile_field_key: string; verified: boolean; verification_source: string | null; success_count: number; failure_count: number; last_verified_at: Date | null }[]>`
    select id, scope, domain, field_label, profile_field_key, verified, verification_source, success_count, failure_count, last_verified_at
      from form_mappings
     where scope in ('WEBSITE', 'GLOBAL')
       ${f.scope ? sql`and scope = ${f.scope}` : sql``}
       ${like ? sql`and (normalized_label like ${like} or domain like ${like} or profile_field_key like ${like})` : sql``}
     order by verified desc, success_count desc limit 300`;
  return rows.map((r) => ({
    id: r.id, scope: r.scope, domain: r.domain, label: r.field_label, key: r.profile_field_key,
    keyLabel: r.profile_field_key === NOT_A_PROFILE_FIELD ? "Not a profile field" : (getFieldDef(r.profile_field_key)?.label.en ?? r.profile_field_key),
    verified: r.verified, source: r.verification_source, support: r.success_count, against: r.failure_count, lastVerifiedAt: r.last_verified_at?.toISOString() ?? null,
  }));
}

/**
 * Switch a shared pattern off (it stays off: the learning job never re-verifies
 * admin-disabled rows) or confirm it as admin-verified.
 */
export async function setPattern(actor: Actor, id: string, action: "disable" | "verify", reason: string, ip?: string) {
  assertAdmin(actor, "admin:learning_manage");
  if (!reason.trim()) throw badRequest("Give a reason (it is kept in the audit log)");
  const rows = await db().system`
    update form_mappings
       set verified = ${action === "verify"}, verification_source = ${action === "verify" ? "admin" : "admin_disabled"}, last_verified_at = now()
     where id = ${id} and scope in ('WEBSITE', 'GLOBAL') returning id`;
  if (!rows.length) throw notFound("Pattern not found");
  await audit({ actorId: actor.id, actorRole: actor.role, action: `admin.pattern_${action === "verify" ? "verified" : "disabled"}`, targetType: "form_mapping", targetId: id, ip, metadata: { reason: reason.trim().slice(0, 300) } });
  kickLearning(5_000);
  return { saved: true as const };
}

/** Where the assistant is most often corrected (per provider), to guide rules and training. */
export async function correctionStats(actor: Actor) {
  assertAdmin(actor, "admin:analytics_view");
  return db().system<{ original_mapping: string | null; correct_mapping: string; original_provider: string | null; n: number }[]>`
    select original_mapping, correct_mapping, original_provider, count(*)::int as n
      from learning_corrections group by 1, 2, 3 order by n desc limit 20`;
}
