import type { NextRequest } from "next/server";
import { companionEnabled } from "@/server/companion/planner";
import { claimLocalStep, requireDevice } from "@/server/companion/service";
import { json, rateLimit, route } from "@/server/http";

/** Next local step addressed to this device (none while revoked or stopped). */
export const POST = route(async (req: NextRequest) => {
  const auth = await requireDevice(req);
  companionEnabled();
  rateLimit("companion-claim", auth.device.id, 60, 60_000);
  return json(await claimLocalStep(auth), { headers: { "Cache-Control": "no-store" } });
});
