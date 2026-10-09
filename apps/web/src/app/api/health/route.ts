import type { NextRequest } from "next/server";
import path from "node:path";
import { readdirSync } from "node:fs";
import { db } from "@/server/db";
import { documentWorkerHeartbeat } from "@/server/documents/worker";
import { env } from "@/server/env";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Health probe. Plain: liveness + database (Docker healthcheck, uptime monitors).
 * `?deep=1`: also migrations, document worker and storage — component states only,
 * no versions, paths or secrets.
 */
export async function GET(req: NextRequest) {
  try {
    await db().system`select 1`;
  } catch {
    return json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
  if (req.nextUrl.searchParams.get("deep") !== "1") return json({ status: "ok" });

  const checks: Record<string, "ok" | "warn" | "fail" | "off"> = { database: "ok" };
  try {
    const [m] = await db().system<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
    let files = 0;
    try {
      files = readdirSync(process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "../../database/migrations")).filter((f) => f.endsWith(".sql")).length;
    } catch {
      files = 0; // migrations are not shipped in the runtime image; the count check is then skipped
    }
    checks.migrations = files === 0 || m!.n >= files ? "ok" : "fail";
  } catch {
    checks.migrations = "fail";
  }
  const hb = documentWorkerHeartbeat();
  checks.documentWorker = !env().DOCUMENT_WORKER_ENABLED ? "off" : !hb.running ? "fail" : hb.lastTickAt && Date.now() - hb.lastTickAt < 60_000 ? "ok" : "warn";
  const [q] = await db().system<{ stuck: number }[]>`
    select count(*)::int as stuck from documents where status = 'PROCESSING' and processing_started_at < now() - interval '30 minutes'`;
  checks.documentQueue = q!.stuck ? "warn" : "ok";
  const status = Object.values(checks).includes("fail") ? "degraded" : Object.values(checks).includes("warn") ? "warn" : "ok";
  return json({ status, checks }, { status: status === "degraded" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
