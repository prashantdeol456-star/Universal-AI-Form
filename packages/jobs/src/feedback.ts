import type { JobRequirements } from "./requirements";
import { mentions } from "./requirements";

/**
 * User feedback for job matching (AI browser Phase 4, step 10). Two kinds act on ranking,
 * and only because the user explicitly made them:
 *
 *  - requirement corrections: the user fixes what was read from ONE job description
 *    (remove a skill that is not really required, add one that was missed, set the years).
 *    They change that job's requirements, and so its fit score, transparently.
 *  - ranking rules: the user's own standing preferences ("prefer employer X", "avoid jobs
 *    mentioning night shift"). They never change the fit score; they add a separate,
 *    bounded adjustment used for ordering, shown with its reasons.
 *
 * "Was this match useful?" votes are stored for the user to review; they change nothing by
 * themselves (a vote can be turned into a ranking rule only by the user). Nothing here
 * trains a model or turns a prediction into a personal fact.
 */

export const CORRECTION_TARGETS = ["required_skill", "preferred_skill", "experience_min_years", "education_level"] as const;
export type CorrectionTarget = (typeof CORRECTION_TARGETS)[number];

export interface RequirementCorrection {
  target: CorrectionTarget;
  action: "add" | "remove" | "set";
  /** Skill name, a number of years, or an education level ("none" clears it). */
  value: string;
}

const LEVELS = new Set(["diploma", "bachelor", "master", "phd"]);
const sameSkill = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function validateCorrection(c: RequirementCorrection): string | null {
  const v = c.value.trim();
  if (!v || v.length > 100) return "Give a value (up to 100 characters)";
  if (c.target === "required_skill" || c.target === "preferred_skill") return c.action === "set" ? "Skills are added or removed" : null;
  if (c.action !== "set") return "Experience and education are set, not added or removed";
  if (c.target === "experience_min_years") {
    if (v === "none") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 60 ? null : "Years must be a number from 0 to 60, or none";
  }
  return v === "none" || LEVELS.has(v) ? null : "Education level must be diploma, bachelor, master, phd or none";
}

/** The job's requirements after the user's corrections, applied in the order they were made. */
export function applyCorrections(req: JobRequirements, corrections: RequirementCorrection[]): JobRequirements {
  const out: JobRequirements = { ...req, requiredSkills: [...req.requiredSkills], preferredSkills: [...req.preferredSkills], mentionedSkills: [...req.mentionedSkills] };
  for (const c of corrections) {
    if (validateCorrection(c)) continue;
    const v = c.value.trim();
    if (c.target === "required_skill" || c.target === "preferred_skill") {
      const key = c.target === "required_skill" ? "requiredSkills" : "preferredSkills";
      const other = c.target === "required_skill" ? "preferredSkills" : "requiredSkills";
      if (c.action === "add") {
        if (!out[key].some((s) => sameSkill(s, v))) out[key].push(v);
        out[other] = out[other].filter((s) => !sameSkill(s, v));
      } else {
        out[key] = out[key].filter((s) => !sameSkill(s, v));
      }
      out.mentionedSkills = out.mentionedSkills.filter((s) => !sameSkill(s, v));
    } else if (c.target === "experience_min_years") {
      out.experienceMinYears = v === "none" ? null : Number(v);
      out.experienceText = v === "none" ? null : `Set by you: ${v}+ years`;
    } else {
      out.education = v === "none" ? null : { level: v as "diploma" | "bachelor" | "master" | "phd", required: true, text: "Set by you" };
    }
  }
  // A requirements list the user edited counts as structured.
  if (corrections.some((c) => (c.target === "required_skill" || c.target === "preferred_skill") && !validateCorrection(c))) out.structured = true;
  return out;
}

export const RULE_KINDS = ["employer", "keyword", "skill", "title_word"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RankingRule {
  id: string;
  kind: RuleKind;
  value: string;
  /** -10..10, never 0. */
  weight: number;
}

export interface RankAdjustment {
  /** Sum of matched rule weights, clamped to ±20. Added to the fit score only for ordering. */
  adjustment: number;
  applied: Array<{ ruleId: string; kind: RuleKind; value: string; weight: number }>;
}

export const MAX_RANK_ADJUSTMENT = 20;

export function rankAdjustment(job: { title: string; employer: string | null; description: string; requiredSkills: string[]; preferredSkills: string[] }, rules: RankingRule[]): RankAdjustment {
  const applied: RankAdjustment["applied"] = [];
  for (const r of rules) {
    const v = r.value.trim();
    if (!v || !r.weight) continue;
    const hit =
      r.kind === "employer"
        ? !!job.employer && sameSkill(job.employer, v)
        : r.kind === "keyword"
          ? mentions(`${job.title}\n${job.description}`, v.toLowerCase())
          : r.kind === "skill"
            ? [...job.requiredSkills, ...job.preferredSkills].some((s) => sameSkill(s, v))
            : mentions(job.title, v.toLowerCase());
    if (hit) applied.push({ ruleId: r.id, kind: r.kind, value: v, weight: Math.max(-10, Math.min(10, Math.round(r.weight))) });
  }
  const sum = applied.reduce((s, a) => s + a.weight, 0);
  return { adjustment: Math.max(-MAX_RANK_ADJUSTMENT, Math.min(MAX_RANK_ADJUSTMENT, sum)), applied };
}
