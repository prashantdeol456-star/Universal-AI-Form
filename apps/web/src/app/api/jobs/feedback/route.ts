import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { listFeedback } from "@/server/jobs/feedback";

/** Everything the user taught the job ranking: votes, corrections and ranking rules (for review and deletion). */
export const GET = route(async () => {
  const user = await requireUser();
  return json(await listFeedback(user), { headers: { "Cache-Control": "no-store" } });
});
