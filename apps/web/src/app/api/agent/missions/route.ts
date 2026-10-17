import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { listMissions, planMission } from "@/server/companion/missions";
import { companionEnabled } from "@/server/companion/planner";
import { missionPlanSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ missions: await listMissions(user) }, { headers: { "Cache-Control": "no-store" } });
});

/** Planner agent: splits the request into steps for your computers. Nothing runs until you start it. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("agent-plan", user.id, 30, 10 * 60_000);
  const { request, deviceId } = await parseBody(req, missionPlanSchema);
  return json(await planMission(user, request, deviceId), { headers: { "Cache-Control": "no-store" } });
});
