import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { runWorkflow } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { workflowRunSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { kickTaskRunner } from "@/server/tasks/runner";

/** Starts an approved workflow as a new task (all approvals still apply). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("task-create", user.id, 30, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const { deviceId } = await parseBody(req, workflowRunSchema);
  const r = await runWorkflow(user, id, deviceId);
  if (r.created) kickTaskRunner();
  return json(r, { status: 201 });
});
