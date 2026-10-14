import type { NextRequest } from "next/server";
import type { JsonObject } from "@ufa/tasks";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { checkpointSchema } from "@/server/tasks/schemas";

/** Saves the checkpoint of a worker that holds the task lease. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("task-checkpoint", user.id, 300, 60_000);
  const id = z.uuid().parse((await params).id);
  const { leaseToken, data } = await parseBody(req, checkpointSchema);
  return json(await tasks().saveCheckpoint(user, id, leaseToken, data as JsonObject));
});
