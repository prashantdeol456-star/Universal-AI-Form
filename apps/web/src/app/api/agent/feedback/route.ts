import { requireUser } from "@/server/auth/session";
import { listFeedback } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { json, route } from "@/server/http";

/** All feedback the user gave on tasks (Memory page). */
export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ feedback: await listFeedback(user, null) }, { headers: { "Cache-Control": "no-store" } });
});
