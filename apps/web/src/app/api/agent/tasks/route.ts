import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { companionEnabled, createLocalTask } from "@/server/companion/planner";
import { localTaskSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { kickTaskRunner } from "@/server/tasks/runner";

/** Creates a computer task after checking the device, folders and permissions. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("task-create", user.id, 30, 10 * 60_000);
  const body = await parseBody(req, localTaskSchema);
  const r = await createLocalTask(user, body);
  if (r.created) kickTaskRunner();
  return json(r, { status: r.created ? 201 : 200 });
});
