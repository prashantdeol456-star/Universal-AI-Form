import "server-only";
import { computeCompletion } from "@ufa/profile-engine";
import { asUser, type Actor } from "./db";

export interface DashboardStats {
  totalApplications: number;
  applicationsThisMonth: number;
  documents: number;
  profileCompletion: number;
  verifiedCompletion: number;
  missingCoreFields: string[];
  pendingReviews: number;
  /** Filled and confirmed, but not yet marked as submitted by the user. */
  awaitingSubmit: number;
  submitted: number;
  savedForms: number;
  openConflicts: number;
  ai: { totalRequests: number; aiFillSuccessPct: number | null; geminiUsagePct: number | null };
  recentApplications: { id: string; formName: string | null; domain: string; status: string; createdAt: string }[];
  recentActivity: { action: string; createdAt: string }[];
}

/** Every number here is a real query over the user's own rows (RLS-scoped). */
export async function getDashboardStats(actor: Actor): Promise<DashboardStats> {
  return asUser(actor, async (tx) => {
    const [apps] = (await tx`
      select count(*)::int as total,
             count(*) filter (where created_at >= date_trunc('month', now()))::int as month,
             count(*) filter (where status in ('WAITING_FOR_USER', 'READY_FOR_REVIEW'))::int as pending,
             count(*) filter (where status = 'CONFIRMED')::int as awaiting,
             count(*) filter (where status = 'SUBMITTED')::int as submitted
        from applications where customer_id = ${actor.id}`) as unknown as [{ total: number; month: number; pending: number; awaiting: number; submitted: number }];
    const [saved] = (await tx`select count(*)::int as n from saved_forms where user_id = ${actor.id} and deleted_at is null`) as unknown as [{ n: number }];
    const [docs] = (await tx`select count(*)::int as n from documents where user_id = ${actor.id} and deleted_at is null`) as unknown as [{ n: number }];
    const [conf] = (await tx`select count(*)::int as n from document_conflicts where user_id = ${actor.id} and status = 'OPEN'`) as unknown as [{ n: number }];
    const fields = await tx<{ field_key: string; verified: boolean }[]>`
      select field_key, verified from profile_fields where user_id = ${actor.id} and deleted_at is null`;
    const [ai] = (await tx`
      select count(*)::int as total,
             count(*) filter (where provider = 'gemini')::int as gemini,
             count(*) filter (where user_confirmed is not null)::int as reviewed,
             count(*) filter (where user_confirmed and not coalesce(user_corrected, false))::int as accepted
        from ai_requests where user_id = ${actor.id}`) as unknown as [{ total: number; gemini: number; reviewed: number; accepted: number }];
    const recentApps = await tx<{ id: string; form_name: string | null; domain: string; status: string; created_at: Date }[]>`
      select id, form_name, domain, status, created_at from applications
       where customer_id = ${actor.id} order by created_at desc limit 5`;
    const activity = await tx<{ action: string; created_at: Date }[]>`
      select action, created_at from audit_logs where subject_user_id = ${actor.id}
       order by created_at desc limit 8`;

    const completion = computeCompletion(fields.map((f) => ({ fieldKey: f.field_key, verified: f.verified })));
    return {
      totalApplications: apps.total,
      applicationsThisMonth: apps.month,
      documents: docs.n,
      profileCompletion: completion.percent,
      verifiedCompletion: completion.verifiedPercent,
      missingCoreFields: completion.missingCore,
      pendingReviews: apps.pending,
      awaitingSubmit: apps.awaiting,
      submitted: apps.submitted,
      savedForms: saved.n,
      openConflicts: conf.n,
      ai: {
        totalRequests: ai.total,
        aiFillSuccessPct: ai.reviewed ? Math.round((ai.accepted / ai.reviewed) * 100) : null,
        geminiUsagePct: ai.total ? Math.round((ai.gemini / ai.total) * 100) : null,
      },
      recentApplications: recentApps.map((a) => ({ id: a.id, formName: a.form_name, domain: a.domain, status: a.status, createdAt: a.created_at.toISOString() })),
      recentActivity: activity.map((a) => ({ action: a.action, createdAt: a.created_at.toISOString() })),
    };
  });
}
