import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { companionEnabled, planRequest } from "@/server/companion/planner";
import { planSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";

/** Turns a request into a proposed computer task (nothing is created or run). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("agent-plan", user.id, 30, 10 * 60_000);
  const { deviceId, request } = await parseBody(req, planSchema);
  return json(await planRequest(user, deviceId, request), { headers: { "Cache-Control": "no-store" } });
});
