import { APPLICATION_STATUSES, CORRECTION_TARGETS, RULE_KINDS, WORK_ARRANGEMENTS } from "@ufa/jobs";
import { z } from "zod";

/** Request validation for the jobs API (all bounded; unknown keys refused). */
const text = (max: number) => z.string().trim().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");
const list = (maxItems: number, maxLen: number) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);

export const searchSchema = z.object({
  q: text(120).optional(),
  title: text(120).optional(),
  employer: text(120).optional(),
  location: text(120).optional(),
  arrangement: z.enum(WORK_ARRANGEMENTS).optional(),
  employmentType: text(60).optional(),
  maxExperience: z.coerce.number().min(0).max(60).optional(),
  since: date.optional(),
  saved: z.enum(["saved", "unsaved", "shortlisted"]).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  includeClosed: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  sort: z.enum(["score", "recent"]).optional(),
  page: z.coerce.number().int().min(1).max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export const addJobSchema = z
  .object({
    url: z.string().trim().min(8).max(2000),
    title: text(300).nullish(),
    employer: text(200).nullish(),
    location: text(300).nullish(),
    employmentType: text(80).nullish(),
    description: z.string().max(30_000).nullish(),
  })
  .strict();

export const addSourceSchema = z
  .object({ sourceType: z.enum(["greenhouse", "lever"]), sourceKey: z.string().trim().min(1).max(80), region: z.enum(["global", "eu"]).optional() })
  .strict();

export const saveSchema = z
  .object({ saved: z.boolean(), notes: text(4000).nullish(), priority: z.number().int().min(1).max(3).optional(), shortlisted: z.boolean().optional() })
  .strict();

export const applicationSchema = z
  .object({
    status: z.enum(APPLICATION_STATUSES).optional(),
    confirmSubmitted: z.boolean().optional(),
    deadline: date.nullable().optional(),
    nextFollowUp: date.nullable().optional(),
    notes: text(4000).nullable().optional(),
    applicationUrl: z.string().trim().max(2000).regex(/^https:\/\//, "Use an https link").nullable().optional(),
  })
  .strict();

export const preferencesSchema = z
  .object({
    roles: list(20, 100),
    locations: list(20, 100),
    workArrangements: z.array(z.enum(WORK_ARRANGEMENTS)).max(3),
    employmentTypes: list(10, 60),
    industries: list(20, 100),
    experienceMin: z.number().min(0).max(60).nullable(),
    experienceMax: z.number().min(0).max(60).nullable(),
    salaryMin: z.number().min(0).max(1e12).nullable(),
    salaryMax: z.number().min(0).max(1e12).nullable(),
    salaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  })
  .strict()
  .refine((p) => p.experienceMin === null || p.experienceMax === null || p.experienceMin <= p.experienceMax, "Minimum experience is above the maximum")
  .refine((p) => p.salaryMin === null || p.salaryMax === null || p.salaryMin <= p.salaryMax, "Minimum salary is above the maximum");

export const answerSchema = z.object({ question: z.string().trim().min(3).max(300) }).strict();

export const feedbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("match_useful"), useful: z.boolean(), reason: text(500).nullish() }).strict(),
  z
    .object({
      kind: z.literal("requirement_correction"),
      target: z.enum(CORRECTION_TARGETS),
      action: z.enum(["add", "remove", "set"]),
      value: z.string().trim().min(1).max(100),
      reason: text(500).nullish(),
    })
    .strict(),
]);

export const ruleSchema = z
  .object({
    kind: z.enum(RULE_KINDS),
    value: z.string().trim().min(1).max(100),
    weight: z.number().int().min(-10).max(10).refine((n) => n !== 0, "Weight cannot be 0"),
    reason: text(500).nullish(),
    sourceFeedbackId: z.uuid().nullish(),
  })
  .strict();
