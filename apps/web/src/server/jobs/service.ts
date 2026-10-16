import "server-only";
import {
  checkTransition,
  extractRequirements,
  fetchGreenhouseBoard,
  fetchGreenhouseJob,
  fetchLeverPosting,
  fetchLeverSite,
  isStale,
  JOB_LIMITS,
  manualJob,
  parseJobUrl,
  SourceError,
  validateGreenhouseToken,
  validateLeverSite,
  type ApplicationStatus,
  type FetchLike,
  type MatchResult,
  type NormalizedJob,
  type WorkArrangement,
} from "@ufa/jobs";
import type { TransactionSql } from "@ufa/db";
import { audit } from "../audit";
import { asUser, type Actor } from "../db";
import { badRequest, conflict, HttpError, notFound } from "../http";
import { computeMatches, loadCandidate } from "./matching";
import type { ApplicationView, JobAnalysisView, JobDetail, JobPreferencesView, JobSourceView, JobSummary } from "./types";

/**
 * Job discovery and tracking service (AI browser Phase 4). Every query runs as the user
 * (RLS) and filters by the user's id. Sources are fetched on the user's request only, with
 * a minimum interval per source; nothing is fetched in the background.
 */
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests replace the network. */
export function setJobFetch(f: FetchLike) {
  fetchImpl = f;
}

const SOURCE_LABEL: Record<string, string> = { greenhouse: "Greenhouse job board", lever: "Lever job board", manual: "Added by you" };

function sourceError(err: unknown): never {
  if (err instanceof SourceError) {
    const status = err.code === "invalid_source" ? 400 : err.code === "not_found" ? 404 : err.code === "rate_limited" ? 429 : 502;
    throw new HttpError(status, `job_source_${err.code}`, err.message);
  }
  throw err;
}

// --- Storing listings -----------------------------------------------------------------

/** Insert or refresh one listing (dedupe by provider id, then canonical URL). Returns its id. */
async function upsertListing(tx: TransactionSql, userId: string, sourceId: string | null, j: NormalizedJob, profileSkills: string[]): Promise<string> {
  const req = extractRequirements(j.description, profileSkills);
  const values = {
    title: j.title,
    employer: j.employer,
    location: j.location,
    work_arrangement: j.workArrangement,
    employment_type: j.employmentType,
    description: j.description,
    required_skills: req.requiredSkills.slice(0, 100),
    preferred_skills: req.preferredSkills.slice(0, 100),
    mentioned_skills: req.mentionedSkills.slice(0, 100),
    experience_min_years: req.experienceMinYears,
    experience_text: req.experienceText,
    education_level: req.education?.level ?? null,
    education_required: req.education ? req.education.required : null,
    requirements_structured: req.structured,
    salary_min: j.salary?.min ?? null,
    salary_max: j.salary?.max ?? null,
    salary_currency: j.salary?.currency ?? null,
    salary_period: j.salary?.period ?? null,
    salary_source: j.salary?.sourceField ?? null,
    apply_url: j.applyUrl,
    published_at: j.publishedAt,
    provider_updated_at: j.providerUpdatedAt,
    source_metadata: j.metadata,
  };
  const [existing] = j.providerJobId
    ? await tx<{ id: string }[]>`select id from job_listings where user_id = ${userId} and source_type = ${j.sourceType} and source_key = ${j.sourceKey} and provider_job_id = ${j.providerJobId}`
    : await tx<{ id: string }[]>`select id from job_listings where user_id = ${userId} and canonical_url = ${j.canonicalUrl}`;
  // Adding a link that is already in the list never overwrites the details the user typed before.
  if (existing && j.sourceType === "manual") return existing.id;
  if (existing) {
    await tx`
      update job_listings set ${tx(values as never)}, canonical_url = ${j.canonicalUrl},
             source_id = coalesce(${sourceId}, source_id), status = ${j.sourceType === "manual" ? "unknown" : "open"},
             retrieved_at = now(), last_seen_at = now()
       where id = ${existing.id}`;
    return existing.id;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into job_listings ${tx({
      ...values,
      user_id: userId,
      source_id: sourceId,
      source_type: j.sourceType,
      source_key: j.sourceKey,
      provider_job_id: j.providerJobId,
      canonical_url: j.canonicalUrl,
      status: j.sourceType === "manual" ? "unknown" : "open",
    } as never)}
    on conflict (user_id, canonical_url) do update set last_seen_at = now(), retrieved_at = now()
    returning id`;
  return row!.id;
}

// --- Sources ------------------------------------------------------------------------------

function toSourceView(r: { id: string; source_type: "greenhouse" | "lever"; source_key: string; region: "global" | "eu"; display_name: string | null; last_fetched_at: Date | null; last_status: JobSourceView["lastStatus"]; last_error: string | null; job_count: number }): JobSourceView {
  const wait = r.last_fetched_at ? Math.max(0, Math.ceil((r.last_fetched_at.getTime() + JOB_LIMITS.minRefreshMs - Date.now()) / 1000)) : 0;
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceKey: r.source_key,
    region: r.region,
    displayName: r.display_name,
    lastFetchedAt: r.last_fetched_at?.toISOString() ?? null,
    lastStatus: r.last_status,
    lastError: r.last_error,
    jobCount: r.job_count,
    refreshAvailableIn: wait,
  };
}

export async function listSources(actor: Actor): Promise<JobSourceView[]> {
  const rows = await asUser(actor, (tx) => tx<Parameters<typeof toSourceView>[0][]>`select * from job_sources where user_id = ${actor.id} order by created_at`);
  return rows.map(toSourceView);
}

export async function addSource(actor: Actor, input: { sourceType: "greenhouse" | "lever"; sourceKey: string; region?: "global" | "eu" }, ip?: string): Promise<JobSourceView> {
  let key: string;
  try {
    key = input.sourceType === "greenhouse" ? validateGreenhouseToken(input.sourceKey) : validateLeverSite(input.sourceKey);
  } catch (err) {
    sourceError(err);
  }
  const region = input.sourceType === "lever" ? input.region ?? "global" : "global";
  const id = await asUser(actor, async (tx) => {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from job_sources where user_id = ${actor.id}`;
    if (n!.n >= 30) throw badRequest("You can follow up to 30 job boards");
    const [row] = await tx<{ id: string }[]>`
      insert into job_sources (user_id, source_type, source_key, region) values (${actor.id}, ${input.sourceType}, ${key}, ${region})
      on conflict (user_id, source_type, source_key, region) do nothing returning id`;
    if (!row) throw conflict("You already follow this job board");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "jobs.source_added", targetType: "job_source", targetId: row.id, subjectUserId: actor.id, ip, metadata: { sourceType: input.sourceType } }, tx);
    return row.id;
  });
  return refreshSource(actor, id);
}

export async function removeSource(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`delete from job_sources where id = ${id} and user_id = ${actor.id} returning id`;
    if (!rows.length) throw notFound("Job board not found");
  });
}

/**
 * Fetches a followed board (at most once per JOB_LIMITS.minRefreshMs), stores its open
 * jobs, marks jobs no longer listed as closed, and recomputes their fit scores.
 */
export async function refreshSource(actor: Actor, id: string): Promise<JobSourceView> {
  const src = await asUser(actor, async (tx) => {
    const [s] = await tx<Parameters<typeof toSourceView>[0][]>`select * from job_sources where id = ${id} and user_id = ${actor.id}`;
    if (!s) throw notFound("Job board not found");
    return s;
  });
  if (src.last_fetched_at && Date.now() - src.last_fetched_at.getTime() < JOB_LIMITS.minRefreshMs) {
    return toSourceView(src);
  }
  let result: { employer: string | null; jobs: NormalizedJob[] } | null = null;
  let failure: SourceError | null = null;
  try {
    result = src.source_type === "greenhouse" ? await fetchGreenhouseBoard(fetchImpl, src.source_key) : await fetchLeverSite(fetchImpl, src.source_key, src.region);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    failure = err;
  }
  await asUser(actor, async (tx) => {
    if (!result) {
      await tx`update job_sources set last_fetched_at = now(), last_status = ${failure!.code === "rate_limited" ? "rate_limited" : failure!.code === "not_found" ? "not_found" : "error"},
                  last_error = ${failure!.message.slice(0, 300)} where id = ${id}`;
      return;
    }
    const candidate = await loadCandidate(tx, actor.id);
    const ids: string[] = [];
    for (const j of result.jobs) ids.push(await upsertListing(tx, actor.id, id, j, candidate.profileSkills));
    // Jobs from this board that were not listed this time are closed at the source.
    await tx`update job_listings set status = 'closed' where user_id = ${actor.id} and source_id = ${id} and status = 'open' and not (id = any(${ids}::uuid[]))`;
    await tx`update job_sources set last_fetched_at = now(), last_status = 'ok', last_error = null, job_count = ${ids.length},
                display_name = coalesce(${result.employer}, display_name) where id = ${id}`;
    if (ids.length) await computeMatches(tx, actor.id, candidate, ids);
  });
  const [after] = await asUser(actor, (tx) => tx<Parameters<typeof toSourceView>[0][]>`select * from job_sources where id = ${id}`);
  return toSourceView(after!);
}

// --- Adding a single job ------------------------------------------------------------------

export async function addJob(
  actor: Actor,
  input: { url: string; title?: string | null; employer?: string | null; location?: string | null; description?: string | null; employmentType?: string | null },
  ip?: string,
): Promise<{ id: string; sourceType: string }> {
  let job: NormalizedJob;
  try {
    const parsed = parseJobUrl(input.url);
    if (parsed.kind === "greenhouse") job = await fetchGreenhouseJob(fetchImpl, parsed.token, parsed.jobId);
    else if (parsed.kind === "lever") job = await fetchLeverPosting(fetchImpl, parsed.site, parsed.postingId, parsed.region);
    else {
      // No permitted API for this site: nothing is fetched; the user gives the details.
      if (!input.title?.trim()) throw new SourceError("invalid_source", "This site cannot be read automatically. Add the job title (and paste the description) yourself.");
      job = manualJob({ url: parsed.url, title: input.title, employer: input.employer, location: input.location, description: input.description, employmentType: input.employmentType });
    }
  } catch (err) {
    sourceError(err);
  }
  return asUser(actor, async (tx) => {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from job_listings where user_id = ${actor.id}`;
    if (n!.n >= 5000) throw badRequest("You have too many saved listings. Remove some first.");
    const candidate = await loadCandidate(tx, actor.id);
    const id = await upsertListing(tx, actor.id, null, job, candidate.profileSkills);
    await computeMatches(tx, actor.id, candidate, [id]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: "jobs.job_added", targetType: "job_listing", targetId: id, subjectUserId: actor.id, ip, metadata: { sourceType: job.sourceType } }, tx);
    return { id, sourceType: job.sourceType };
  });
}

export async function removeJob(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`delete from job_listings where id = ${id} and user_id = ${actor.id} returning id`;
    if (!rows.length) throw notFound("Job not found");
  });
}

// --- Search ---------------------------------------------------------------------------------

export interface JobSearch {
  q?: string;
  title?: string;
  employer?: string;
  location?: string;
  arrangement?: WorkArrangement;
  employmentType?: string;
  /** Jobs that ask for at most this many years (or do not say). */
  maxExperience?: number;
  /** Discovered (retrieved) on or after this date. */
  since?: string;
  saved?: "saved" | "unsaved";
  minScore?: number;
  maxScore?: number;
  includeClosed?: boolean;
  sort?: "score" | "recent";
  page?: number;
  pageSize?: number;
}

interface SummaryRow {
  id: string;
  source_type: JobSummary["sourceType"];
  title: string;
  employer: string | null;
  location: string | null;
  work_arrangement: WorkArrangement | null;
  employment_type: string | null;
  experience_min_years: string | null;
  salary_min: string | null;
  salary_max: string | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_source: string | null;
  canonical_url: string;
  published_at: Date | null;
  retrieved_at: Date;
  last_seen_at: Date;
  status: JobSummary["status"];
  score: number | null;
  provisional: boolean | null;
  saved: boolean;
  shortlisted: boolean | null;
  priority: number | null;
  application_status: ApplicationStatus | null;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function toSummary(r: SummaryRow): JobSummary {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceLabel: SOURCE_LABEL[r.source_type] ?? r.source_type,
    title: r.title,
    employer: r.employer,
    location: r.location,
    workArrangement: r.work_arrangement,
    employmentType: r.employment_type,
    experienceMinYears: r.experience_min_years === null ? null : Number(r.experience_min_years),
    salary:
      r.salary_currency && r.salary_source
        ? { min: r.salary_min === null ? null : Number(r.salary_min), max: r.salary_max === null ? null : Number(r.salary_max), currency: r.salary_currency, period: r.salary_period, source: r.salary_source }
        : null,
    canonicalUrl: r.canonical_url,
    publishedAt: r.published_at?.toISOString() ?? null,
    retrievedAt: r.retrieved_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    status: r.status,
    stale: isStale(r.last_seen_at.toISOString(), Date.now(), JOB_LIMITS.staleAfterDays),
    score: r.score,
    provisional: r.provisional,
    saved: r.saved,
    shortlisted: r.shortlisted ?? false,
    priority: r.priority,
    applicationStatus: r.application_status,
  };
}

export async function searchJobs(actor: Actor, s: JobSearch): Promise<{ jobs: JobSummary[]; page: number; pageSize: number; total: number }> {
  const pageSize = Math.min(Math.max(s.pageSize ?? 20, 1), 50);
  const page = Math.min(Math.max(s.page ?? 1, 1), 200);
  return asUser(actor, async (tx) => {
    const where = [
      tx`j.user_id = ${actor.id}`,
      s.includeClosed ? tx`true` : tx`j.status <> 'closed'`,
      s.q ? tx`(j.title ilike ${like(s.q)} or j.employer ilike ${like(s.q)} or j.description ilike ${like(s.q)})` : tx`true`,
      s.title ? tx`j.title ilike ${like(s.title)}` : tx`true`,
      s.employer ? tx`j.employer ilike ${like(s.employer)}` : tx`true`,
      s.location ? tx`j.location ilike ${like(s.location)}` : tx`true`,
      s.arrangement ? tx`j.work_arrangement = ${s.arrangement}` : tx`true`,
      s.employmentType ? tx`j.employment_type ilike ${like(s.employmentType)}` : tx`true`,
      s.maxExperience !== undefined ? tx`(j.experience_min_years is null or j.experience_min_years <= ${s.maxExperience})` : tx`true`,
      s.since ? tx`j.retrieved_at >= ${s.since}::date` : tx`true`,
      s.saved === "saved" ? tx`sv.job_id is not null` : s.saved === "unsaved" ? tx`sv.job_id is null` : tx`true`,
      s.minScore !== undefined ? tx`m.score >= ${s.minScore}` : tx`true`,
      s.maxScore !== undefined ? tx`m.score <= ${s.maxScore}` : tx`true`,
    ];
    const cond = where.reduce((a, b) => tx`${a} and ${b}`);
    const from = tx`from job_listings j
      left join job_matches m on m.job_id = j.id
      left join job_saves sv on sv.job_id = j.id
      left join job_applications a on a.job_id = j.id`;
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n ${from} where ${cond}`;
    const order = s.sort === "recent" ? tx`j.retrieved_at desc, j.id` : tx`m.score desc nulls last, j.retrieved_at desc, j.id`;
    const rows = await tx<SummaryRow[]>`
      select j.id, j.source_type, j.title, j.employer, j.location, j.work_arrangement, j.employment_type, j.experience_min_years,
             j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.salary_source, j.canonical_url, j.published_at,
             j.retrieved_at, j.last_seen_at, j.status, m.score, m.provisional, (sv.job_id is not null) as saved, sv.shortlisted, sv.priority,
             a.status as application_status
        ${from} where ${cond} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`;
    return { jobs: rows.map(toSummary), page, pageSize, total: count!.n };
  });
}

// --- Detail ---------------------------------------------------------------------------------

function toApplicationView(a: { id: string; job_id: string | null; title: string; employer: string | null; job_url: string | null; application_url: string | null; status: ApplicationStatus; submitted_confirmed_at: Date | null; deadline: string | null; next_follow_up: string | null; notes: string | null; last_activity_at: Date; created_at: Date }): ApplicationView {
  return {
    id: a.id,
    jobId: a.job_id,
    title: a.title,
    employer: a.employer,
    jobUrl: a.job_url,
    applicationUrl: a.application_url,
    status: a.status,
    submittedConfirmedAt: a.submitted_confirmed_at?.toISOString() ?? null,
    deadline: a.deadline,
    nextFollowUp: a.next_follow_up,
    notes: a.notes,
    lastActivityAt: a.last_activity_at.toISOString(),
    createdAt: a.created_at.toISOString(),
  };
}

export async function getJob(actor: Actor, id: string): Promise<JobDetail> {
  return asUser(actor, async (tx) => {
    const [j] = await tx<(SummaryRow & { description: string; apply_url: string | null; required_skills: string[]; preferred_skills: string[]; mentioned_skills: string[]; experience_text: string | null; education_level: string | null; education_required: boolean | null; source_metadata: Record<string, string | null>; ai_analysis: JobAnalysisView | null; explanation: MatchResult | null; computed_at: Date | null; notes: string | null })[]>`
      select j.*, m.score, m.provisional, m.explanation, m.computed_at, (sv.job_id is not null) as saved, sv.shortlisted, sv.priority, sv.notes,
             a.status as application_status
        from job_listings j left join job_matches m on m.job_id = j.id left join job_saves sv on sv.job_id = j.id left join job_applications a on a.job_id = j.id
       where j.id = ${id} and j.user_id = ${actor.id}`;
    if (!j) throw notFound("Job not found");
    const [app] = await tx<Parameters<typeof toApplicationView>[0][]>`
      select id, job_id, title, employer, job_url, application_url, status, submitted_confirmed_at, to_char(deadline, 'YYYY-MM-DD') as deadline,
             to_char(next_follow_up, 'YYYY-MM-DD') as next_follow_up, notes, last_activity_at, created_at
        from job_applications where job_id = ${id} and user_id = ${actor.id}`;
    const events = app
      ? await tx<{ kind: string; from_status: string | null; to_status: string | null; created_at: Date }[]>`
          select kind, from_status, to_status, created_at from job_application_events where application_id = ${app.id} order by created_at desc limit 50`
      : [];
    // Form fills done with the assistant on this job's pages (same host and path prefix).
    const target = new URL(j.apply_url ?? j.canonical_url);
    const prefix = `${target.origin}${target.pathname.replace(/\/apply$/, "")}`;
    const fills = await tx<{ id: string; status: string; created_at: Date; submitted_at: Date | null }[]>`
      select id, status, created_at, submitted_at from applications
       where customer_id = ${actor.id} and website_url like ${`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}
       order by created_at desc limit 10`;
    return {
      ...toSummary(j),
      description: j.description,
      applyUrl: j.apply_url,
      requiredSkills: j.required_skills,
      preferredSkills: j.preferred_skills,
      mentionedSkills: j.mentioned_skills,
      experienceText: j.experience_text,
      education: j.education_level ? { level: j.education_level, required: j.education_required } : null,
      metadata: j.source_metadata,
      match: j.explanation,
      matchComputedAt: j.computed_at?.toISOString() ?? null,
      notes: j.notes,
      analysis: j.ai_analysis,
      application: app ? toApplicationView(app) : null,
      events: events.map((e) => ({ kind: e.kind, fromStatus: e.from_status, toStatus: e.to_status, at: e.created_at.toISOString() })),
      fills: fills.map((f) => ({ id: f.id, status: f.status, createdAt: f.created_at.toISOString(), submittedAt: f.submitted_at?.toISOString() ?? null })),
    };
  });
}

// --- Saving ---------------------------------------------------------------------------------

export async function saveJob(actor: Actor, id: string, input: { saved: boolean; notes?: string | null; priority?: number; shortlisted?: boolean }): Promise<{ saved: boolean }> {
  return asUser(actor, async (tx) => {
    const [j] = await tx`select id from job_listings where id = ${id} and user_id = ${actor.id}`;
    if (!j) throw notFound("Job not found");
    if (!input.saved) {
      await tx`delete from job_saves where job_id = ${id} and user_id = ${actor.id}`;
      return { saved: false };
    }
    await tx`insert into job_saves (user_id, job_id) values (${actor.id}, ${id}) on conflict (user_id, job_id) do nothing`;
    // Only the fields the user sent are changed.
    if (input.notes !== undefined) await tx`update job_saves set notes = ${input.notes} where job_id = ${id} and user_id = ${actor.id}`;
    if (input.priority !== undefined) await tx`update job_saves set priority = ${input.priority} where job_id = ${id} and user_id = ${actor.id}`;
    if (input.shortlisted !== undefined) await tx`update job_saves set shortlisted = ${input.shortlisted} where job_id = ${id} and user_id = ${actor.id}`;
    return { saved: true };
  });
}

// --- Application tracker ----------------------------------------------------------------------

export interface ApplicationUpdate {
  status?: string;
  /** The user confirms they submitted the application themselves (needed for applied and later). */
  confirmSubmitted?: boolean;
  deadline?: string | null;
  nextFollowUp?: string | null;
  notes?: string | null;
  applicationUrl?: string | null;
}

export async function updateApplication(actor: Actor, jobId: string, u: ApplicationUpdate, ip?: string): Promise<ApplicationView> {
  return asUser(actor, async (tx) => {
    const [job] = await tx<{ id: string; title: string; employer: string | null; canonical_url: string; apply_url: string | null }[]>`
      select id, title, employer, canonical_url, apply_url from job_listings where id = ${jobId} and user_id = ${actor.id}`;
    if (!job) throw notFound("Job not found");
    let [app] = await tx<{ id: string; status: ApplicationStatus; submitted_confirmed_at: Date | null }[]>`
      select id, status, submitted_confirmed_at from job_applications where job_id = ${jobId} and user_id = ${actor.id} for update`;
    if (!app) {
      [app] = await tx<{ id: string; status: ApplicationStatus; submitted_confirmed_at: Date | null }[]>`
        insert into job_applications (user_id, job_id, title, employer, job_url, application_url, status)
        values (${actor.id}, ${jobId}, ${job.title}, ${job.employer}, ${job.canonical_url}, ${job.apply_url}, 'interested')
        returning id, status, submitted_confirmed_at`;
      await tx`insert into job_application_events (user_id, application_id, kind, to_status) values (${actor.id}, ${app!.id}, 'created', 'interested')`;
    }
    const a = app!;
    if (u.status !== undefined && u.status !== a.status) {
      const check = checkTransition(a.status, u.status, u.confirmSubmitted === true || a.submitted_confirmed_at !== null);
      if (!check.ok) throw new HttpError(check.code === "confirm_applied" ? 409 : 400, check.code, check.message);
      const confirming = u.confirmSubmitted === true && !a.submitted_confirmed_at;
      await tx`update job_applications set status = ${u.status}, last_activity_at = now(),
                  submitted_confirmed_at = ${confirming ? tx`now()` : tx`submitted_confirmed_at`} where id = ${a.id}`;
      await tx`insert into job_application_events (user_id, application_id, kind, from_status, to_status) values (${actor.id}, ${a.id}, 'status', ${a.status}, ${u.status})`;
      if (confirming) await audit({ actorId: actor.id, actorRole: actor.role, action: "jobs.application_marked_submitted", targetType: "job_application", targetId: a.id, subjectUserId: actor.id, ip }, tx);
    }
    if (u.deadline !== undefined) {
      await tx`update job_applications set deadline = ${u.deadline}, last_activity_at = now() where id = ${a.id}`;
      await tx`insert into job_application_events (user_id, application_id, kind) values (${actor.id}, ${a.id}, 'deadline')`;
    }
    if (u.nextFollowUp !== undefined) {
      await tx`update job_applications set next_follow_up = ${u.nextFollowUp}, last_activity_at = now() where id = ${a.id}`;
      await tx`insert into job_application_events (user_id, application_id, kind) values (${actor.id}, ${a.id}, 'follow_up')`;
    }
    if (u.notes !== undefined) {
      await tx`update job_applications set notes = ${u.notes}, last_activity_at = now() where id = ${a.id}`;
      await tx`insert into job_application_events (user_id, application_id, kind) values (${actor.id}, ${a.id}, 'notes')`;
    }
    if (u.applicationUrl !== undefined) await tx`update job_applications set application_url = ${u.applicationUrl} where id = ${a.id}`;
    const [out] = await tx<Parameters<typeof toApplicationView>[0][]>`
      select id, job_id, title, employer, job_url, application_url, status, submitted_confirmed_at, to_char(deadline, 'YYYY-MM-DD') as deadline,
             to_char(next_follow_up, 'YYYY-MM-DD') as next_follow_up, notes, last_activity_at, created_at
        from job_applications where id = ${a.id}`;
    return toApplicationView(out!);
  });
}

export async function listApplications(actor: Actor): Promise<ApplicationView[]> {
  const rows = await asUser(actor, (tx) => tx<Parameters<typeof toApplicationView>[0][]>`
    select id, job_id, title, employer, job_url, application_url, status, submitted_confirmed_at, to_char(deadline, 'YYYY-MM-DD') as deadline,
           to_char(next_follow_up, 'YYYY-MM-DD') as next_follow_up, notes, last_activity_at, created_at
      from job_applications where user_id = ${actor.id}
     order by coalesce(least(deadline, next_follow_up), deadline, next_follow_up) asc nulls last, last_activity_at desc
     limit 500`);
  return rows.map(toApplicationView);
}

// --- Preferences --------------------------------------------------------------------------------

export async function getPreferences(actor: Actor): Promise<JobPreferencesView> {
  const [p] = await asUser(actor, (tx) => tx<{ roles: string[]; locations: string[]; work_arrangements: WorkArrangement[]; employment_types: string[]; industries: string[]; experience_min: string | null; experience_max: string | null; salary_min: string | null; salary_max: string | null; salary_currency: string | null; updated_at: Date }[]>`
    select * from job_preferences where user_id = ${actor.id}`);
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    roles: p?.roles ?? [],
    locations: p?.locations ?? [],
    workArrangements: p?.work_arrangements ?? [],
    employmentTypes: p?.employment_types ?? [],
    industries: p?.industries ?? [],
    experienceMin: n(p?.experience_min),
    experienceMax: n(p?.experience_max),
    salaryMin: n(p?.salary_min),
    salaryMax: n(p?.salary_max),
    salaryCurrency: p?.salary_currency ?? null,
    updatedAt: p?.updated_at.toISOString() ?? null,
  };
}

/** Saves the preferences the user chose (every one optional) and recomputes fit scores. */
export async function savePreferences(actor: Actor, v: Omit<JobPreferencesView, "updatedAt">): Promise<JobPreferencesView> {
  await asUser(actor, async (tx) => {
    const prefs = {
      roles: v.roles,
      locations: v.locations,
      work_arrangements: v.workArrangements,
      employment_types: v.employmentTypes,
      industries: v.industries,
      experience_min: v.experienceMin,
      experience_max: v.experienceMax,
      salary_min: v.salaryMin,
      salary_max: v.salaryMax,
      salary_currency: v.salaryCurrency,
    };
    await tx`insert into job_preferences ${tx({ user_id: actor.id, ...prefs } as never)}
      on conflict (user_id) do update set ${tx(prefs as never)}, updated_at = now()`;
    await computeMatches(tx, actor.id, await loadCandidate(tx, actor.id));
  });
  return getPreferences(actor);
}
