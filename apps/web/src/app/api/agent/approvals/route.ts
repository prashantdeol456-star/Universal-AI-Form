import { requireUser } from "@/server/auth/session";
import { pendingLocalApprovals } from "@/server/companion/missions";
import { companionEnabled } from "@/server/companion/planner";
import { json, route } from "@/server/http";

/** Approvals waiting for you on computer tasks (approve or reject them with /api/approvals/:id). */
export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ approvals: await pendingLocalApprovals(user) }, { headers: { "Cache-Control": "no-store" } });
});
