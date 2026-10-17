import "server-only";
import { validateCorrection, type CorrectionTarget, type RuleKind } from "@ufa/jobs";
import { audit } from "../audit";
import { asUser, type Actor } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { computeMatches, loadCandidate } from "./matching";

/**
 * Job-matching feedback (step 10). Votes are stored for review only. Corrections change one
 * job's requirements. Ranking rules are the user's own preferences and only re-order jobs.
 * Everything is the user's to review and delete; nothing becomes a profile fact or trains a
 * model.
 */
export type FeedbackInput =
  | { kind: "match_useful"; useful: boolean; reason?: string | null }
  | { kind: "requirement_correction"; target: CorrectionTarget; action: "add" | "remove" | "set"; value: string; reason?: string | null };

export interface FeedbackView {
  id: string;
  jobId: string | null;
  jobTitle: string | null;
  kind: FeedbackInput["kind"];
  useful: boolean | null;
  target: CorrectionTarget | null;
  action: "add" | "remove" | "set" | null;
  value: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RuleView {
  id: string;
  kind: RuleKind;
  value: string;
  weight: number;
  reason: string | null;
  sourceFeedbackId: string | null;
  createdAt: string;
}

export async function addFeedback(actor: Actor, jobId: string, input: FeedbackInput): Promise<FeedbackView> {
  if (input.kind === "requirement_correction") {
    const problem = validateCorrection(input);
    if (problem) throw badRequest(problem);
  }
  return asUser(actor, async (tx) => {
    const [job] = await tx<{ title: string }[]>`select title from job_listings where id = ${jobId} and user_id = ${actor.id}`;
    if (!job) throw notFound("Job not found");
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from job_feedback where user_id = ${actor.id}`;
    if (n!.n >= 5000) throw badRequest("You have a lot of feedback saved. Delete some first.");
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      insert into job_feedback (user_id, job_id, kind, useful, target, action, value, reason)
      values (${actor.id}, ${jobId}, ${input.kind}, ${input.kind === "match_useful" ? input.useful : null},
              ${input.kind === "requirement_correction" ? input.target : null}, ${input.kind === "requirement_correction" ? input.action : null},
              ${input.kind === "requirement_correction" ? input.value.trim() : null}, ${input.reason?.trim() || null})
      returning id, created_at`;
    if (input.kind === "requirement_correction") await computeMatches(tx, actor.id, await loadCandidate(tx, actor.id), [jobId]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: "jobs.feedback_added", targetType: "job_listing", targetId: jobId, subjectUserId: actor.id, metadata: { kind: input.kind } }, tx);
    return {
      id: row!.id,
      jobId,
      jobTitle: job.title,
      kind: input.kind,
      useful: input.kind === "match_useful" ? input.useful : null,
      target: input.kind === "requirement_correction" ? input.target : null,
      action: input.kind === "requirement_correction" ? input.action : null,
      value: input.kind === "requirement_correction" ? input.value.trim() : null,
      reason: input.reason?.trim() || null,
      createdAt: row!.created_at.toISOString(),
    };
  });
}

export async function listFeedback(actor: Actor, jobId?: string): Promise<{ feedback: FeedbackView[]; rules: RuleView[] }> {
  return asUser(actor, async (tx) => {
    const fb = await tx<{ id: string; job_id: string | null; title: string | null; kind: FeedbackInput["kind"]; useful: boolean | null; target: CorrectionTarget | null; action: "add" | "remove" | "set" | null; value: string | null; reason: string | null; created_at: Date }[]>`
      select f.id, f.job_id, j.title, f.kind, f.useful, f.target, f.action, f.value, f.reason, f.created_at
        from job_feedback f left join job_listings j on j.id = f.job_id
       where f.user_id = ${actor.id} ${jobId ? tx`and f.job_id = ${jobId}` : tx``}
       order by f.created_at desc limit 500`;
    const rules = jobId
      ? []
      : await tx<{ id: string; kind: RuleKind; value: string; weight: number; reason: string | null; source_feedback_id: string | null; created_at: Date }[]>`
          select id, kind, value, weight, reason, source_feedback_id, created_at from job_ranking_rules where user_id = ${actor.id} order by created_at desc`;
    return {
      feedback: fb.map((f) => ({ id: f.id, jobId: f.job_id, jobTitle: f.title, kind: f.kind, useful: f.useful, target: f.target, action: f.action, value: f.value, reason: f.reason, createdAt: f.created_at.toISOString() })),
      rules: rules.map((r) => ({ id: r.id, kind: r.kind, value: r.value, weight: r.weight, reason: r.reason, sourceFeedbackId: r.source_feedback_id, createdAt: r.created_at.toISOString() })),
    };
  });
}

export async function deleteFeedback(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const [f] = await tx<{ job_id: string | null; kind: string }[]>`delete from job_feedback where id = ${id} and user_id = ${actor.id} returning job_id, kind`;
    if (!f) throw notFound("Feedback not found");
    if (f.kind === "requirement_correction" && f.job_id) await computeMatches(tx, actor.id, await loadCandidate(tx, actor.id), [f.job_id]);
  });
}

export async function addRule(actor: Actor, input: { kind: RuleKind; value: string; weight: number; reason?: string | null; sourceFeedbackId?: string | null }): Promise<RuleView> {
  const value = input.value.trim();
  if (!value || value.length > 100) throw badRequest("Give the rule a value (up to 100 characters)");
  if (!Number.isInteger(input.weight) || input.weight === 0 || Math.abs(input.weight) > 10) throw badRequest("Weight must be between -10 and 10, not 0");
  return asUser(actor, async (tx) => {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from job_ranking_rules where user_id = ${actor.id}`;
    if (n!.n >= 100) throw badRequest("You can have up to 100 ranking rules");
    if (input.sourceFeedbackId) {
      const [f] = await tx`select id from job_feedback where id = ${input.sourceFeedbackId} and user_id = ${actor.id}`;
      if (!f) throw notFound("Feedback not found");
    }
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      insert into job_ranking_rules (user_id, kind, value, weight, reason, source_feedback_id)
      values (${actor.id}, ${input.kind}, ${value}, ${input.weight}, ${input.reason?.trim() || null}, ${input.sourceFeedbackId ?? null})
      on conflict do nothing returning id, created_at`;
    if (!row) throw conflict("You already have a rule for this");
    await computeMatches(tx, actor.id, await loadCandidate(tx, actor.id));
    return { id: row.id, kind: input.kind, value, weight: input.weight, reason: input.reason?.trim() || null, sourceFeedbackId: input.sourceFeedbackId ?? null, createdAt: row.created_at.toISOString() };
  });
}

export async function deleteRule(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`delete from job_ranking_rules where id = ${id} and user_id = ${actor.id} returning id`;
    if (!rows.length) throw notFound("Rule not found");
    await computeMatches(tx, actor.id, await loadCandidate(tx, actor.id));
  });
}
