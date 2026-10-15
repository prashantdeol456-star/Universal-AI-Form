import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { claimSchema } from "@/server/tasks/schemas";

/**
 * The signed-in user's extension claims its next browser step. Only the caller's own tasks
 * can be claimed (RLS + user id from the session). The lease token is returned once and is
 * required for every report about the step.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("task-claim", user.id, 120, 60_000);
  const { workerId, taskId } = await parseBody(req, claimSchema);
  const claim = await tasks().claimBrowserStep(user, `${user.sessionId.slice(0, 8)}:${workerId}`, taskId ?? null);
  return json({ claim }, { headers: { "Cache-Control": "no-store" } });
});
