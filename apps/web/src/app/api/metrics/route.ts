import type { NextRequest } from "next/server";
import { safeEqual } from "@ufa/security";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { renderMetrics } from "@/server/metrics";

export const dynamic = "force-dynamic";

/**
 * Prometheus metrics. Disabled unless METRICS_TOKEN is set; then requires
 * `Authorization: Bearer <METRICS_TOKEN>`. Counts only — no user data.
 */
export async function GET(req: NextRequest) {
  const token = env().METRICS_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || !given || !safeEqual(given, token)) return new Response("Not found", { status: 404 });

  const [r] = await db().system<{
    users: number; docs_queued: number; docs_failed: number; cafe_active: number; ai_fail_1h: number; ai_1h: number;
    learning_age: number | null; deletions: number; db_bytes: number;
  }[]>`
    select (select count(*)::int from users where deleted_at is null) as users,
           (select count(*)::int from documents where status in ('UPLOADED', 'PROCESSING') and deleted_at is null) as docs_queued,
           (select count(*)::int from documents where status = 'FAILED' and deleted_at is null) as docs_failed,
           (select count(*)::int from cafe_sessions where status = 'ACTIVE' and expires_at > now()) as cafe_active,
           (select count(*)::int from ai_requests where created_at > now() - interval '1 hour' and not success) as ai_fail_1h,
           (select count(*)::int from ai_requests where created_at > now() - interval '1 hour') as ai_1h,
           (select extract(epoch from now() - max(finished_at))::int from learning_runs where error is null) as learning_age,
           (select count(*)::int from users where deletion_scheduled_for is not null) as deletions,
           pg_database_size(current_database())::bigint as db_bytes`;
  const body = renderMetrics({
    ufa_users: { help: "Accounts", value: r!.users },
    ufa_documents_queued: { help: "Documents waiting for OCR", value: r!.docs_queued },
    ufa_documents_failed: { help: "Documents whose processing failed", value: r!.docs_failed },
    ufa_cafe_sessions_active: { help: "Running café sessions", value: r!.cafe_active },
    ufa_ai_requests_1h: { help: "AI requests in the last hour", value: r!.ai_1h },
    ufa_ai_failures_1h: { help: "Failed AI requests in the last hour", value: r!.ai_fail_1h },
    ufa_learning_last_run_age_seconds: { help: "Seconds since the last successful learning run (-1 = never)", value: r!.learning_age ?? -1 },
    ufa_accounts_pending_deletion: { help: "Accounts scheduled for deletion", value: r!.deletions },
    ufa_database_size_bytes: { help: "PostgreSQL database size", value: Number(r!.db_bytes) },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" } });
}
