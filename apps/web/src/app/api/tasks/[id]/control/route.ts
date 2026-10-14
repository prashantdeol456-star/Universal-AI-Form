import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { kickTaskRunner } from "@/server/tasks/runner";
import { controlSchema } from "@/server/tasks/schemas";

/** Pause, resume, cancel or retry. Invalid transitions answer 409 with code "invalid_transition". */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("task-control", user.id, 120, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const body = await parseBody(req, controlSchema);
  const engine = tasks();
  const task =
    body.action === "pause"
      ? await engine.pause(user, id)
      : body.action === "resume"
        ? await engine.resume(user, id)
        : body.action === "cancel"
          ? await engine.cancel(user, id)
          : await engine.retry(user, id, { stepId: body.stepId ?? null, confirmUncertain: body.confirmUncertain });
  if (task.status === "queued") kickTaskRunner();
  return json({ status: task.status });
});
