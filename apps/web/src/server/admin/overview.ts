import "server-only";
import { db, type Actor } from "../db";
import { assertAdmin } from "./guard";

/** Platform numbers for the admin overview: counts and rates only, no personal data. */
export interface AdminOverview {
  users: { total: number; byRole: Record<string, number>; suspended: number; new30d: number; verifiedPct: number };
  cafes: { total: number; active: number; activeSessions: number };
  applications: { total: number; last30d: number; submitted30d: number; viaCafe30d: number };
  documents: { total: number; queued: number; failed: number };
  ai: {
    requests30d: number;
    byProvider: Record<string, number>;
    geminiFields30d: number;
    geminiTokens30d: number;
    failures30d: number;
    suggestionsConfirmed: number;
    suggestionsCorrected: number;
  };
  learning: { pending: number; approved: number; rejected: number; websitePatterns: number; globalPatterns: number; lastRunAt: string | null };
  models: { production: { name: string; servingName: string | null; promotedAt: string | null } | null; datasets: number };
  perDay: Array<{ day: string; signups: number; applications: number; aiRequests: number }>;
}

export async function adminOverview(actor: Actor): Promise<AdminOverview> {
  assertAdmin(actor, "admin:analytics_view");
  const sql = db().system;
  const [u] = await sql<{ total: number; suspended: number; new30d: number; verified: number }[]>`
    select count(*)::int as total,
           count(*) filter (where status = 'SUSPENDED')::int as suspended,
           count(*) filter (where created_at >= now() - interval '30 days')::int as new30d,
           count(*) filter (where email_verified_at is not null)::int as verified
      from users where deleted_at is null`;
  const roles = await sql<{ role: string; n: number }[]>`select role, count(*)::int as n from users where deleted_at is null group by role`;
  const [c] = await sql<{ total: number; active: number; sessions: number }[]>`
    select (select count(*)::int from cafes where deleted_at is null) as total,
           (select count(*)::int from cafes where deleted_at is null and status = 'ACTIVE') as active,
           (select count(*)::int from cafe_sessions where status = 'ACTIVE' and expires_at > now()) as sessions`;
  const [a] = await sql<{ total: number; d30: number; sub30: number; cafe30: number }[]>`
    select count(*)::int as total,
           count(*) filter (where created_at >= now() - interval '30 days')::int as d30,
           count(*) filter (where created_at >= now() - interval '30 days' and status = 'SUBMITTED')::int as sub30,
           count(*) filter (where created_at >= now() - interval '30 days' and cafe_id is not null)::int as cafe30
      from applications`;
  const [d] = await sql<{ total: number; queued: number; failed: number }[]>`
    select count(*)::int as total,
           count(*) filter (where status in ('UPLOADED', 'PROCESSING'))::int as queued,
           count(*) filter (where status = 'FAILED')::int as failed
      from documents where deleted_at is null`;
  const providers = await sql<{ provider: string; n: number; items: number; tokens: number; failed: number }[]>`
    select provider, count(*)::int as n, coalesce(sum(items), 0)::int as items,
           coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::int as tokens,
           count(*) filter (where not success)::int as failed
      from ai_requests where created_at >= now() - interval '30 days' group by provider`;
  const [s] = await sql<{ confirmed: number; corrected: number }[]>`
    select count(*) filter (where user_confirmed)::int as confirmed, count(*) filter (where user_corrected)::int as corrected from ai_field_suggestions`;
  const [l] = await sql<{ pending: number; approved: number; rejected: number }[]>`
    select count(*) filter (where status = 'PENDING')::int as pending,
           count(*) filter (where status = 'APPROVED')::int as approved,
           count(*) filter (where status = 'REJECTED')::int as rejected
      from learning_examples`;
  const [k] = await sql<{ website: number; global: number }[]>`
    select count(*) filter (where scope = 'WEBSITE' and verified)::int as website, count(*) filter (where scope = 'GLOBAL' and verified)::int as global
      from form_mappings where scope in ('WEBSITE', 'GLOBAL')`;
  const [run] = await sql<{ finished_at: Date | null }[]>`select finished_at from learning_runs where finished_at is not null order by finished_at desc limit 1`;
  const [prod] = await sql<{ name: string; serving_name: string | null; promoted_at: Date | null }[]>`
    select name, serving_name, promoted_at from model_versions where status = 'PRODUCTION'`;
  const [ds] = await sql<{ n: number }[]>`select count(*)::int as n from training_datasets`;
  const days = await sql<{ day: string; signups: number; applications: number; ai: number }[]>`
    select to_char(d, 'YYYY-MM-DD') as day,
           (select count(*)::int from users where created_at >= d and created_at < d + interval '1 day') as signups,
           (select count(*)::int from applications where created_at >= d and created_at < d + interval '1 day') as applications,
           (select count(*)::int from ai_requests where created_at >= d and created_at < d + interval '1 day') as ai
      from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') as d
     order by d`;

  return {
    users: { total: u!.total, byRole: Object.fromEntries(roles.map((r) => [r.role, r.n])), suspended: u!.suspended, new30d: u!.new30d, verifiedPct: u!.total ? Math.round((u!.verified / u!.total) * 100) : 0 },
    cafes: { total: c!.total, active: c!.active, activeSessions: c!.sessions },
    applications: { total: a!.total, last30d: a!.d30, submitted30d: a!.sub30, viaCafe30d: a!.cafe30 },
    documents: { total: d!.total, queued: d!.queued, failed: d!.failed },
    ai: {
      requests30d: providers.reduce((n, p) => n + p.n, 0),
      byProvider: Object.fromEntries(providers.map((p) => [p.provider, p.n])),
      geminiFields30d: providers.find((p) => p.provider === "gemini")?.items ?? 0,
      geminiTokens30d: providers.find((p) => p.provider === "gemini")?.tokens ?? 0,
      failures30d: providers.reduce((n, p) => n + p.failed, 0),
      suggestionsConfirmed: s!.confirmed,
      suggestionsCorrected: s!.corrected,
    },
    learning: { pending: l!.pending, approved: l!.approved, rejected: l!.rejected, websitePatterns: k!.website, globalPatterns: k!.global, lastRunAt: run?.finished_at?.toISOString() ?? null },
    models: { production: prod ? { name: prod.name, servingName: prod.serving_name, promotedAt: prod.promoted_at?.toISOString() ?? null } : null, datasets: ds!.n },
    perDay: days.map((x) => ({ day: x.day, signups: x.signups, applications: x.applications, aiRequests: x.ai })),
  };
}
