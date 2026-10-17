import type { NextRequest } from "next/server";
import { companionEnabled } from "@/server/companion/planner";
import { heartbeatSchema } from "@/server/companion/schemas";
import { heartbeat, requireDevice } from "@/server/companion/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

/** The companion reports its folders and learns the stop state, its capabilities and revoked folders. */
export const POST = route(async (req: NextRequest) => {
  const auth = await requireDevice(req);
  companionEnabled();
  rateLimit("companion-heartbeat", auth.device.id, 60, 60_000);
  return json(await heartbeat(auth, await parseBody(req, heartbeatSchema)), { headers: { "Cache-Control": "no-store" } });
});
