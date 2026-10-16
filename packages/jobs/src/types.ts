/**
 * Job discovery (AI browser Phase 4): the common job schema every source adapter
 * normalises into. Unknown data stays null — never 0 or "" — so the UI can say
 * "not given by the source" instead of inventing a value.
 */
export const SOURCE_TYPES = ["greenhouse", "lever", "manual"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const WORK_ARRANGEMENTS = ["remote", "hybrid", "onsite"] as const;
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];

export interface Salary {
  min: number | null;
  max: number | null;
  /** ISO 4217 code. */
  currency: string;
  /** "year", "month", "hour"… as the source states it, or null. */
  period: string | null;
  /** Which structured provider field it came from (never parsed out of free text). */
  sourceField: string;
}

export interface NormalizedJob {
  sourceType: SourceType;
  /** Greenhouse board token / Lever site name; null for manual jobs. */
  sourceKey: string | null;
  providerJobId: string | null;
  title: string;
  employer: string | null;
  location: string | null;
  workArrangement: WorkArrangement | null;
  employmentType: string | null;
  /** Plain text, bounded (JOB_LIMITS.descriptionChars). Untrusted page content. */
  description: string;
  salary: Salary | null;
  canonicalUrl: string;
  applyUrl: string | null;
  publishedAt: string | null;
  providerUpdatedAt: string | null;
  /** Small, non-personal provider details (department, team, country). */
  metadata: Record<string, string | null>;
}

export const JOB_LIMITS = {
  descriptionChars: 30_000,
  titleChars: 300,
  jobsPerSource: 500,
  /** A whole board response larger than this is refused. */
  responseBytes: 15 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  /** Minimum time between refreshes of one source (provider politeness). */
  minRefreshMs: 10 * 60_000,
  /** A listing not seen or refreshed for this long is shown as stale. */
  staleAfterDays: 14,
} as const;

export class SourceError extends Error {
  constructor(
    public readonly code: "invalid_source" | "not_found" | "rate_limited" | "provider_error" | "too_large" | "timeout" | "invalid_response",
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;
