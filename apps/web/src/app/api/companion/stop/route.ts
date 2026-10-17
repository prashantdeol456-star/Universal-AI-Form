import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { stopDevices } from "@/server/companion/service";
import { json, route } from "@/server/http";

/** Emergency stop for every paired computer of the user. Never rate limited. */
export const POST = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json(await stopDevices(user, null));
});
