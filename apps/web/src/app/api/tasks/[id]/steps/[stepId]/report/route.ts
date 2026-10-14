import type { NextRequest } from "next/server";
import type { JsonObject } from "@ufa/tasks";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { kickTaskRunner } from "@/server/tasks/runner";
import { reportSchema } from "@/server/tasks/schemas";

/** Progress or outcome of a claimed browser step; refused (409 lease_lost) without the current lease. */
export const POST = route<{ params: Promise<{ id: string; stepId: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("task-report", user.id, 300, 60_000);
  const p = await params;
  const id = z.uuid().parse(p.id);
  const stepId = z.uuid().parse(p.stepId);
  const body = await parseBody(req, reportSchema);
  const r = await tasks().reportStep(user, id, stepId, {
    leaseToken: body.leaseToken,
    outcome: body.outcome,
    message: body.message ?? null,
    result: (body.result ?? null) as JsonObject | null,
    checkpoint: (body.checkpoint ?? null) as JsonObject | null,
  });
  if (body.outcome === "completed") kickTaskRunner();
  return json(r);
});
