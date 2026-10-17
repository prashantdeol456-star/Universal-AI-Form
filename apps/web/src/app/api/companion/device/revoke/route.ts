import type { NextRequest } from "next/server";
import { companionEnabled } from "@/server/companion/planner";
import { requireDevice, revokeDevice } from "@/server/companion/service";
import { json, route } from "@/server/http";

/** "ufa-companion unpair": the device removes itself (token ends, its unfinished tasks are cancelled). */
export const POST = route(async (req: NextRequest) => {
  const auth = await requireDevice(req);
  companionEnabled();
  return json(await revokeDevice(auth.actor, auth.device.id));
});
