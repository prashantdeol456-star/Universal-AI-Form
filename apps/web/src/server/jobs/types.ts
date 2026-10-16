// View types for job discovery and tracking (no server-only imports; shared with pages and routes).
import type { ApplicationStatus, MatchResult, SourceType, WorkArrangement } from "@ufa/jobs";

export interface JobSourceView {
  id: string;
  sourceType: "greenhouse" | "lever";
  sourceKey: string;
  region: "global" | "eu";
  displayName: string | null;
  lastFetchedAt: string | null;
  lastStatus: "never" | "ok" | "error" | "rate_limited" | "not_found";
  lastError: string | null;
  jobCount: number;
  /** Seconds until the source may be refreshed again (provider politeness). */
  refreshAvailableIn: number;
}

export interface JobSummary {
  id: string;
  sourceType: SourceType;
  sourceLabel: string;
  title: string;
  employer: string | null;
  location: string | null;
  workArrangement: WorkArrangement | null;
  employmentType: string | null;
  experienceMinYears: number | null;
  salary: { min: number | null; max: number | null; currency: string; period: string | null; source: string } | null;
  canonicalUrl: string;
  publishedAt: string | null;
  retrievedAt: string;
  lastSeenAt: string;
  status: "open" | "closed" | "unknown";
  /** Not seen at its source for a while (or a manual job nobody re-checks after 14 days). */
  stale: boolean;
  score: number | null;
  provisional: boolean | null;
  saved: boolean;
  shortlisted: boolean;
  priority: number | null;
  applicationStatus: ApplicationStatus | null;
}

export interface JobAnalysisView {
  provider: "local" | "gemini";
  summary: string;
  responsibilities: Array<{ text: string; quote: string }>;
  requirements: Array<{ text: string; quote: string; kind: "required" | "preferred" }>;
  dropped: number;
  analyzedAt: string;
}

export interface ApplicationView {
  id: string;
  jobId: string | null;
  title: string;
  employer: string | null;
  jobUrl: string | null;
  applicationUrl: string | null;
  status: ApplicationStatus;
  submittedConfirmedAt: string | null;
  deadline: string | null;
  nextFollowUp: string | null;
  notes: string | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface JobDetail extends JobSummary {
  description: string;
  applyUrl: string | null;
  requiredSkills: string[];
  preferredSkills: string[];
  mentionedSkills: string[];
  experienceText: string | null;
  education: { level: string; required: boolean | null } | null;
  metadata: Record<string, string | null>;
  match: MatchResult | null;
  matchComputedAt: string | null;
  notes: string | null;
  analysis: JobAnalysisView | null;
  application: ApplicationView | null;
  events: Array<{ kind: string; fromStatus: string | null; toStatus: string | null; at: string }>;
  /** Forms the user filled with the assistant on this job's site (evidence of the real state). */
  fills: Array<{ id: string; status: string; createdAt: string; submittedAt: string | null }>;
}

export interface JobPreferencesView {
  roles: string[];
  locations: string[];
  workArrangements: WorkArrangement[];
  employmentTypes: string[];
  industries: string[];
  experienceMin: number | null;
  experienceMax: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  updatedAt: string | null;
}
