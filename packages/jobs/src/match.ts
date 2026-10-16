import type { JobRequirements } from "./requirements";
import type { WorkArrangement } from "./types";

/**
 * Transparent, deterministic job fit score (0–100) from the user's own records.
 *
 * Each factor has a fixed weight and earns a credit between 0 and 1. A factor that does
 * not apply (the job says nothing about it, or the user set no preference for it) is left
 * out and the remaining weights are rescaled, so an unspecified preference never lowers the
 * score. Evidence levels:
 *   verified (confirmed in the profile) 1.0 · in an uploaded document 0.8 ·
 *   in the profile but not confirmed 0.6 · not found 0.
 * This is a fit estimate from the user's records, not a probability of being hired.
 */
export const MATCH_WEIGHTS = {
  requiredSkills: 40,
  experience: 20,
  education: 10,
  title: 10,
  preferredSkills: 10,
  location: 5,
  workArrangement: 3,
  employmentType: 2,
} as const;
export type MatchFactorKey = keyof typeof MATCH_WEIGHTS;

export const EVIDENCE_CREDIT = { verified: 1, document: 0.8, unconfirmed: 0.6, missing: 0 } as const;
export type EvidenceStatus = keyof typeof EVIDENCE_CREDIT;

export interface Evidence {
  status: EvidenceStatus;
  /** Human-readable source: "Profile: Key Skills (confirmed)", "cv.pdf, page 2 · Work Experience". */
  source: string | null;
  documentId?: string | null;
  page?: number | null;
}

export type QualificationLevel = "school" | "diploma" | "bachelor" | "master" | "phd";
const LEVEL_RANK: Record<QualificationLevel, number> = { school: 0, diploma: 1, bachelor: 2, master: 3, phd: 4 };

export interface CandidateFacts {
  /** Evidence for one skill in the user's records (profile skills, then documents). */
  skillEvidence: (skill: string) => Evidence;
  experienceYears: { value: number; verified: boolean; source: string } | null;
  qualification: { level: QualificationLevel | null; text: string; verified: boolean; source: string } | null;
  designation: string | null;
}

export interface JobPreferenceInput {
  roles: string[];
  locations: string[];
  workArrangements: WorkArrangement[];
  employmentTypes: string[];
}

export interface JobForMatch {
  title: string;
  location: string | null;
  workArrangement: WorkArrangement | null;
  employmentType: string | null;
  requirements: JobRequirements;
}

export interface MatchFactor {
  key: MatchFactorKey;
  label: string;
  weight: number;
  applicable: boolean;
  /** 0..1, null when not applicable. */
  credit: number | null;
  detail: string;
}

export interface SkillCheck {
  skill: string;
  kind: "required" | "preferred";
  evidence: Evidence;
}

export interface MatchResult {
  /** 0–100, or null when no factor applies (description too thin). */
  score: number | null;
  /** Few requirements could be read from the description: treat the score with care. */
  provisional: boolean;
  factors: MatchFactor[];
  skills: SkillCheck[];
  strong: string[];
  needsReview: string[];
  missing: string[];
  note: string;
}

/** "Post Graduation (MBA)" → master; unknown wording → null (never guessed upwards). */
export function qualificationLevel(text: string | null | undefined): QualificationLevel | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\b(ph\.?d|doctorate)\b/.test(t)) return "phd";
  if (/\b(post[- ]?graduat\w*|master'?s?|mba|m\.?tech|m\.?sc|m\.?com|mca|ma\b|pg\b)/.test(t)) return "master";
  if (/\b(graduat\w*|bachelor'?s?|b\.?tech|b\.?e\b|b\.?sc|b\.?com|bca|bba|ba\b|degree)/.test(t)) return "bachelor";
  if (/\bdiploma|polytechnic|iti\b/.test(t)) return "diploma";
  if (/\b(10th|12th|class 10|class 12|matric\w*|intermediate|high school|secondary)\b/.test(t)) return "school";
  return null;
}

const TITLE_NOISE = new Set(["senior", "sr", "junior", "jr", "lead", "head", "principal", "associate", "assistant", "staff", "intern", "trainee", "i", "ii", "iii", "iv", "the", "of", "and", "for", "to", "a", "an", "-", "–", "/", "&"]);
const titleWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/s$/, ""))
    .filter((w) => w.length > 1 && !TITLE_NOISE.has(w));

function titleOverlap(jobTitle: string, wanted: string): number {
  const a = new Set(titleWords(jobTitle));
  const b = titleWords(wanted);
  if (!a.size || !b.length) return 0;
  return b.filter((w) => a.has(w)).length / b.length;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function matchJob(job: JobForMatch, me: CandidateFacts, prefs: JobPreferenceInput): MatchResult {
  const r = job.requirements;
  const factors: MatchFactor[] = [];
  const strong: string[] = [];
  const needsReview: string[] = [];
  const missing: string[] = [];
  const add = (key: MatchFactorKey, label: string, credit: number | null, detail: string) =>
    factors.push({ key, label, weight: MATCH_WEIGHTS[key], applicable: credit !== null, credit: credit === null ? null : Math.max(0, Math.min(1, credit)), detail });

  // Skills: required (or, with no headings, all skills mentioned) and preferred.
  // No requirements section (or one without recognisable skills): the skills mentioned elsewhere stand in, and the score is provisional.
  const requiredList = r.requiredSkills.length ? r.requiredSkills : r.mentionedSkills;
  const skills: SkillCheck[] = [
    ...requiredList.map((skill) => ({ skill, kind: "required" as const, evidence: me.skillEvidence(skill) })),
    ...r.preferredSkills.map((skill) => ({ skill, kind: "preferred" as const, evidence: me.skillEvidence(skill) })),
  ];
  const credit = (list: SkillCheck[]) => (list.length ? list.reduce((s, x) => s + EVIDENCE_CREDIT[x.evidence.status], 0) / list.length : null);
  const req = skills.filter((s) => s.kind === "required");
  const pref = skills.filter((s) => s.kind === "preferred");
  for (const s of skills) {
    const tag = s.kind === "preferred" ? " (preferred)" : "";
    if (s.evidence.status === "verified" || s.evidence.status === "document") strong.push(`${s.skill}${tag}`);
    else if (s.evidence.status === "unconfirmed") needsReview.push(`${s.skill}${tag}: in your profile but not confirmed`);
    else missing.push(`${s.skill}${tag}: not found in your confirmed profile or documents`);
  }
  add("requiredSkills", r.requiredSkills.length ? "Required skills" : "Skills mentioned", credit(req), req.length ? `${req.filter((s) => s.evidence.status !== "missing").length} of ${req.length} found in your records` : "The description lists no recognisable required skills");
  add("preferredSkills", "Preferred skills", credit(pref), pref.length ? `${pref.filter((s) => s.evidence.status !== "missing").length} of ${pref.length} found` : "No preferred skills listed");

  // Experience.
  if (r.experienceMinYears === null) add("experience", "Experience", null, "The job states no minimum experience");
  else if (!me.experienceYears) {
    add("experience", "Experience", 0, `Needs ${r.experienceMinYears}+ years; your experience is not in your records`);
    needsReview.push(`Experience: the job asks for ${r.experienceMinYears}+ years; add your total experience to your profile`);
  } else {
    const ratio = Math.min(1, me.experienceYears.value / r.experienceMinYears);
    const c = ratio * (me.experienceYears.verified ? 1 : 0.7);
    add("experience", "Experience", c, `Needs ${r.experienceMinYears}+ years; you have ${me.experienceYears.value} (${me.experienceYears.verified ? "confirmed" : "not confirmed"})`);
    if (ratio >= 1 && me.experienceYears.verified) strong.push(`${me.experienceYears.value} years of experience (needs ${r.experienceMinYears}+)`);
    else if (ratio >= 1) needsReview.push(`Experience: ${me.experienceYears.value} years is in your profile but not confirmed`);
    else missing.push(`Experience: the job asks for ${r.experienceMinYears}+ years, your records show ${me.experienceYears.value}`);
  }

  // Education: only when the job names a level.
  if (!r.education) add("education", "Education", null, "The job states no education level");
  else if (!me.qualification?.level) {
    add("education", "Education", 0, `Asks for ${r.education.level}${r.education.required ? "" : " (preferred)"}; your qualification is not in your records`);
    needsReview.push(`Education: add your highest qualification to your profile`);
  } else {
    const ok = LEVEL_RANK[me.qualification.level] >= LEVEL_RANK[r.education.level];
    const c = ok ? (me.qualification.verified ? 1 : 0.7) : 0;
    add("education", "Education", r.education.required ? c : c === 0 ? 0.5 : c, `Asks for ${r.education.level}${r.education.required ? "" : " (preferred)"}; you have ${me.qualification.text} (${me.qualification.verified ? "confirmed" : "not confirmed"})`);
    if (!ok) (r.education.required ? missing : needsReview).push(`Education: asks for ${r.education.level}`);
  }

  // Title: against the user's preferred roles, else their current designation.
  const wanted = prefs.roles.length ? prefs.roles : me.designation ? [me.designation] : [];
  if (!wanted.length) add("title", "Role", null, "Set preferred roles to compare job titles");
  else {
    const best = Math.max(...wanted.map((w) => titleOverlap(job.title, w)));
    add("title", "Role", best, prefs.roles.length ? `Title overlap with your preferred roles: ${pct(best)}` : `Title overlap with your current designation: ${pct(best)}`);
  }

  // Preferences only count when the user set them.
  if (!prefs.locations.length) add("location", "Location", null, "No preferred locations set");
  else if (!job.location && job.workArrangement !== "remote") add("location", "Location", null, "The job gives no location");
  else {
    const hit = prefs.locations.some((l) => (job.location ?? "").toLowerCase().includes(l.toLowerCase())) || (job.workArrangement === "remote" && prefs.locations.some((l) => /remote/i.test(l)));
    add("location", "Location", hit ? 1 : 0, hit ? `${job.location ?? "Remote"} matches your preferred locations` : `${job.location} is not one of your preferred locations`);
  }
  if (!prefs.workArrangements.length) add("workArrangement", "Work arrangement", null, "No preference set");
  else if (!job.workArrangement) add("workArrangement", "Work arrangement", null, "The job does not say remote, hybrid or on-site");
  else add("workArrangement", "Work arrangement", prefs.workArrangements.includes(job.workArrangement) ? 1 : 0, `Job is ${job.workArrangement}`);
  if (!prefs.employmentTypes.length) add("employmentType", "Employment type", null, "No preference set");
  else if (!job.employmentType) add("employmentType", "Employment type", null, "The job does not state the employment type");
  else {
    const hit = prefs.employmentTypes.some((t) => job.employmentType!.toLowerCase().includes(t.toLowerCase()));
    add("employmentType", "Employment type", hit ? 1 : 0, `Job is ${job.employmentType}`);
  }

  const applicable = factors.filter((f) => f.applicable);
  const total = applicable.reduce((s, f) => s + f.weight, 0);
  const score = total ? Math.round((100 * applicable.reduce((s, f) => s + f.weight * f.credit!, 0)) / total) : null;
  const readable = requiredList.length + r.preferredSkills.length + (r.experienceMinYears === null ? 0 : 1) + (r.education ? 1 : 0);
  return {
    score,
    provisional: score === null || readable < 3 || !r.structured || r.requiredSkills.length === 0,
    factors,
    skills,
    strong,
    needsReview,
    missing,
    note: "A fit estimate from your confirmed profile and documents, not a chance of being hired.",
  };
}
