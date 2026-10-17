import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { listDevices } from "@/server/companion/service";
import { json, route } from "@/server/http";

/** The user's paired computers with their capabilities, folders (display copies) and online state. */
export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ devices: await listDevices(user) }, { headers: { "Cache-Control": "no-store" } });
});
