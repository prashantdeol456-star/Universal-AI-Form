import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { listWorkflows, workflowFromTask } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { workflowCreateSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ workflows: await listWorkflows(user) }, { headers: { "Cache-Control": "no-store" } });
});

/** Saves a finished computer task as a DRAFT workflow; it must be reviewed and approved before use. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("agent-workflow", user.id, 30, 10 * 60_000);
  const { taskId, name } = await parseBody(req, workflowCreateSchema);
  return json(await workflowFromTask(user, taskId, name), { status: 201 });
});
