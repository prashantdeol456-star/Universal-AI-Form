import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { controlMission, startMission } from "@/server/companion/missions";
import { companionEnabled } from "@/server/companion/planner";
import { missionControlSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { kickTaskRunner } from "@/server/tasks/runner";

/** Start, pause, resume or cancel a mission; retry or skip one failed step. Nothing is retried automatically. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("agent-mission", user.id, 60, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const { action, seq } = await parseBody(req, missionControlSchema);
  const r = action === "start" ? await startMission(user, id) : await controlMission(user, id, action, seq);
  kickTaskRunner();
  return json(r);
});
