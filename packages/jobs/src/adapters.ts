import { checkUrl } from "@ufa/form-engine";
import { canonicalUrl, clip, decodeEntities, detectArrangement, htmlToText, tidy } from "./text";
import { JOB_LIMITS, SourceError, type FetchLike, type NormalizedJob, type Salary } from "./types";

/**
 * Job source adapters (AI browser Phase 4). Only documented public, read-only endpoints:
 *
 *  - Greenhouse Job Board API — https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 *    ("Job Board data is publicly available, so authentication is not required for any GET
 *    endpoints"; robots.txt only disallows /embed/).
 *  - Lever Postings API — https://api.lever.co/v0/postings/{site}?mode=json (EU:
 *    api.eu.lever.co); robots.txt asks for a 1 s crawl delay.
 *
 * Applying through these APIs (their POST endpoints) is never used: the user applies on the
 * employer's own page. LinkedIn, Naukri and other sites without a permitted API are not
 * fetched at all; for them the user adds the job by URL and pastes the details.
 */

const GH_TOKEN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const LEVER_SITE = /^[a-z0-9][a-z0-9-]{0,79}$/i;

/** One request at a time per host, at least `gapMs` apart (provider politeness / crawl-delay). */
const lastCall = new Map<string, number>();
async function politeFetch(fetchImpl: FetchLike, url: string, gapMs = 1_000): Promise<string> {
  const host = new URL(url).host;
  const wait = (lastCall.get(host) ?? 0) + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(host, Date.now());
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "UniversalAIFormAssistant/1.0 (personal job tracker)" }, signal: AbortSignal.timeout(JOB_LIMITS.requestTimeoutMs) });
  } catch (err) {
    const timeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    throw new SourceError(timeout ? "timeout" : "provider_error", timeout ? "The job source did not answer in time" : "The job source could not be reached");
  }
  if (res.status === 404) throw new SourceError("not_found", "This job board was not found. Check the company name in its jobs URL.");
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new SourceError("rate_limited", "The job source asked us to slow down. Try again later.", Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  if (!res.ok) throw new SourceError("provider_error", `The job source answered with HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > JOB_LIMITS.responseBytes) throw new SourceError("too_large", "The job board is too large to load");
  const text = await res.text();
  if (text.length > JOB_LIMITS.responseBytes) throw new SourceError("too_large", "The job board is too large to load");
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("invalid_response", "The job source returned something that is not JSON");
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  const d = typeof v === "number" ? new Date(v) : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const c = checkUrl(s);
  return c.ok && s.startsWith("https://") ? canonicalUrl(s) : null;
};

// --- Greenhouse ----------------------------------------------------------------

export function validateGreenhouseToken(token: string): string {
  const t = token.trim().toLowerCase();
  if (!GH_TOKEN.test(t)) throw new SourceError("invalid_source", "A Greenhouse board name has letters, digits, - or _ only (e.g. the “acme” in boards.greenhouse.io/acme)");
  return t;
}

interface GhJob {
  id?: unknown;
  title?: unknown;
  absolute_url?: unknown;
  updated_at?: unknown;
  first_published?: unknown;
  location?: { name?: unknown } | null;
  content?: unknown;
  departments?: Array<{ name?: unknown }>;
  offices?: Array<{ name?: unknown }>;
  metadata?: Array<{ name?: unknown; value?: unknown }> | null;
  pay_input_ranges?: Array<{ min_cents?: unknown; max_cents?: unknown; currency_type?: unknown; title?: unknown }>;
}

export function normalizeGreenhouseJob(j: GhJob, token: string, employer: string | null): NormalizedJob | null {
  const id = typeof j.id === "number" || typeof j.id === "string" ? String(j.id) : null;
  const title = clip(str(j.title), JOB_LIMITS.titleChars);
  const url = httpsUrl(j.absolute_url);
  if (!id || !title || !url) return null;
  // Greenhouse returns the description as HTML with its tags entity-encoded.
  const html = str(j.content) ?? "";
  const description = htmlToText(/&lt;\w/.test(html) ? decodeEntities(html) : html, JOB_LIMITS.descriptionChars);
  const location = clip(str(j.location?.name), 300);
  const meta = (name: RegExp) => {
    const m = (j.metadata ?? []).find((x) => typeof x.name === "string" && name.test(x.name));
    return m ? clip(typeof m.value === "string" ? m.value : Array.isArray(m.value) ? m.value.filter((x) => typeof x === "string").join(", ") : null, 80) : null;
  };
  const pay = (j.pay_input_ranges ?? [])[0];
  const currency = str(pay?.currency_type)?.toUpperCase() ?? null;
  const salary: Salary | null =
    pay && currency && /^[A-Z]{3}$/.test(currency) && (num(pay.min_cents) !== null || num(pay.max_cents) !== null)
      ? { min: num(pay.min_cents) === null ? null : num(pay.min_cents)! / 100, max: num(pay.max_cents) === null ? null : num(pay.max_cents)! / 100, currency, period: null, sourceField: "greenhouse.pay_input_ranges" }
      : null;
  return {
    sourceType: "greenhouse",
    sourceKey: token,
    providerJobId: id,
    title,
    employer,
    location,
    workArrangement: detectArrangement(location, title, meta(/workplace|remote|location type/i)),
    employmentType: meta(/employment type|job type|commitment/i),
    description,
    salary,
    canonicalUrl: url,
    applyUrl: url,
    publishedAt: iso(j.first_published),
    providerUpdatedAt: iso(j.updated_at),
    metadata: { department: clip(str(j.departments?.[0]?.name), 120), office: clip(str(j.offices?.[0]?.name), 120) },
  };
}

export async function fetchGreenhouseBoard(fetchImpl: FetchLike, rawToken: string): Promise<{ employer: string | null; jobs: NormalizedJob[]; skipped: number }> {
  const token = validateGreenhouseToken(rawToken);
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;
  const board = parseJson(await politeFetch(fetchImpl, base)) as { name?: unknown };
  const employer = clip(str(board?.name), 200);
  const data = parseJson(await politeFetch(fetchImpl, `${base}/jobs?content=true&pay_transparency=true`)) as { jobs?: unknown };
  if (!Array.isArray(data?.jobs)) throw new SourceError("invalid_response", "The Greenhouse board response had no job list");
  const jobs: NormalizedJob[] = [];
  let skipped = 0;
  for (const j of data.jobs.slice(0, JOB_LIMITS.jobsPerSource)) {
    const n = normalizeGreenhouseJob(j as GhJob, token, employer);
    if (n) jobs.push(n);
    else skipped++;
  }
  return { employer, jobs, skipped: skipped + Math.max(0, data.jobs.length - JOB_LIMITS.jobsPerSource) };
}

export async function fetchGreenhouseJob(fetchImpl: FetchLike, rawToken: string, jobId: string): Promise<NormalizedJob> {
  const token = validateGreenhouseToken(rawToken);
  if (!/^\d{1,20}$/.test(jobId)) throw new SourceError("invalid_source", "This is not a Greenhouse job id");
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;
  const board = parseJson(await politeFetch(fetchImpl, base)) as { name?: unknown };
  const j = parseJson(await politeFetch(fetchImpl, `${base}/jobs/${jobId}?pay_transparency=true`)) as GhJob;
  const n = normalizeGreenhouseJob(j, token, clip(str(board?.name), 200));
  if (!n) throw new SourceError("invalid_response", "The Greenhouse job could not be read");
  return n;
}

// --- Lever ---------------------------------------------------------------------

export function validateLeverSite(site: string): string {
  const s = site.trim().toLowerCase();
  if (!LEVER_SITE.test(s)) throw new SourceError("invalid_source", "A Lever site name has letters, digits or - only (e.g. the “acme” in jobs.lever.co/acme)");
  return s;
}

interface LeverPosting {
  id?: unknown;
  text?: unknown;
  categories?: { location?: unknown; commitment?: unknown; team?: unknown; department?: unknown } | null;
  country?: unknown;
  workplaceType?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  createdAt?: unknown;
  descriptionPlain?: unknown;
  lists?: Array<{ text?: unknown; content?: unknown }>;
  additionalPlain?: unknown;
  salaryRange?: { currency?: unknown; interval?: unknown; min?: unknown; max?: unknown } | null;
}

const prettySite = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function normalizeLeverPosting(p: LeverPosting, site: string): NormalizedJob | null {
  const id = str(p.id);
  const title = clip(str(p.text), JOB_LIMITS.titleChars);
  const url = httpsUrl(p.hostedUrl);
  if (!id || !title || !url || !/^[0-9a-f-]{8,64}$/i.test(id)) return null;
  const parts = [str(p.descriptionPlain) ?? ""];
  for (const l of p.lists ?? []) {
    const head = str(l.text);
    const body = str(l.content);
    if (head || body) parts.push(`${head ?? ""}\n${body ? htmlToText(body, 10_000) : ""}`);
  }
  parts.push(str(p.additionalPlain) ?? "");
  const wt = str(p.workplaceType);
  const location = clip(str(p.categories?.location), 300);
  const sr = p.salaryRange;
  const currency = str(sr?.currency)?.toUpperCase() ?? null;
  const salary: Salary | null =
    sr && currency && /^[A-Z]{3}$/.test(currency) && (num(sr.min) !== null || num(sr.max) !== null)
      ? { min: num(sr.min), max: num(sr.max), currency, period: clip(str(sr.interval), 30), sourceField: "lever.salaryRange" }
      : null;
  return {
    sourceType: "lever",
    sourceKey: site,
    providerJobId: id,
    title,
    // The postings API does not name the company; the site name is shown as given in the URL.
    employer: prettySite(site),
    location,
    workArrangement: wt === "remote" ? "remote" : wt === "hybrid" ? "hybrid" : wt === "on-site" ? "onsite" : detectArrangement(location, title),
    employmentType: clip(str(p.categories?.commitment), 80),
    description: tidy(parts.filter(Boolean).join("\n\n")).slice(0, JOB_LIMITS.descriptionChars),
    salary,
    canonicalUrl: url,
    applyUrl: httpsUrl(p.applyUrl),
    publishedAt: iso(p.createdAt),
    providerUpdatedAt: null,
    metadata: { team: clip(str(p.categories?.team), 120), department: clip(str(p.categories?.department), 120), country: clip(str(p.country), 4) },
  };
}

const leverBase = (region: "global" | "eu") => (region === "eu" ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings");

export async function fetchLeverSite(fetchImpl: FetchLike, rawSite: string, region: "global" | "eu" = "global"): Promise<{ employer: string | null; jobs: NormalizedJob[]; skipped: number }> {
  const site = validateLeverSite(rawSite);
  const data = parseJson(await politeFetch(fetchImpl, `${leverBase(region)}/${encodeURIComponent(site)}?mode=json&limit=${JOB_LIMITS.jobsPerSource}`)) as unknown;
  if (!Array.isArray(data)) throw new SourceError("invalid_response", "The Lever response had no posting list");
  const jobs: NormalizedJob[] = [];
  let skipped = 0;
  for (const p of data.slice(0, JOB_LIMITS.jobsPerSource)) {
    const n = normalizeLeverPosting(p as LeverPosting, site);
    if (n) jobs.push(n);
    else skipped++;
  }
  return { employer: prettySite(site), jobs, skipped };
}

export async function fetchLeverPosting(fetchImpl: FetchLike, rawSite: string, postingId: string, region: "global" | "eu" = "global"): Promise<NormalizedJob> {
  const site = validateLeverSite(rawSite);
  if (!/^[0-9a-f-]{8,64}$/i.test(postingId)) throw new SourceError("invalid_source", "This is not a Lever posting id");
  const p = parseJson(await politeFetch(fetchImpl, `${leverBase(region)}/${encodeURIComponent(site)}/${encodeURIComponent(postingId)}?mode=json`)) as LeverPosting;
  const n = normalizeLeverPosting(p, site);
  if (!n) throw new SourceError("invalid_response", "The Lever posting could not be read");
  return n;
}

// --- URLs and manual jobs -----------------------------------------------------------

export type ParsedJobUrl =
  | { kind: "greenhouse"; token: string; jobId: string }
  | { kind: "lever"; site: string; postingId: string; region: "global" | "eu" }
  | { kind: "other"; url: string };

/** Recognises Greenhouse and Lever job URLs (read through their APIs); anything else needs the user's details. */
export function parseJobUrl(raw: string): ParsedJobUrl {
  const c = checkUrl(raw.trim());
  if (!c.ok || !raw.trim().startsWith("https://")) throw new SourceError("invalid_source", c.ok ? "Job links must use https" : c.reason);
  const u = new URL(raw.trim());
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host === "job-boards.eu.greenhouse.io") && seg.length >= 3 && seg[1] === "jobs" && /^\d+$/.test(seg[2]!)) {
    return { kind: "greenhouse", token: validateGreenhouseToken(seg[0]!), jobId: seg[2]! };
  }
  if ((host === "jobs.lever.co" || host === "jobs.eu.lever.co") && seg.length >= 2) {
    return { kind: "lever", site: validateLeverSite(seg[0]!), postingId: seg[1]!, region: host === "jobs.eu.lever.co" ? "eu" : "global" };
  }
  const url = canonicalUrl(raw);
  if (!url) throw new SourceError("invalid_source", "This is not a valid job link");
  return { kind: "other", url };
}

/** A job the user adds themselves (e.g. from a site without a permitted API). Every field is what the user typed. */
export function manualJob(input: { url: string; title: string; employer?: string | null; location?: string | null; description?: string | null; employmentType?: string | null }): NormalizedJob {
  const url = canonicalUrl(input.url);
  const c = checkUrl(input.url.trim());
  if (!url || !c.ok) throw new SourceError("invalid_source", c.ok ? "Job links must use https" : c.reason);
  const title = clip(input.title, JOB_LIMITS.titleChars);
  if (!title) throw new SourceError("invalid_source", "Give the job a title");
  const description = tidy(input.description ?? "").slice(0, JOB_LIMITS.descriptionChars);
  const location = clip(input.location, 300);
  return {
    sourceType: "manual",
    sourceKey: null,
    providerJobId: null,
    title,
    employer: clip(input.employer, 200),
    location,
    workArrangement: detectArrangement(location, title),
    employmentType: clip(input.employmentType, 80),
    description,
    salary: null,
    canonicalUrl: url,
    applyUrl: url,
    publishedAt: null,
    providerUpdatedAt: null,
    metadata: {},
  };
}
