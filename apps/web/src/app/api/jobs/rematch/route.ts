import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { rematchAll } from "@/server/jobs/matching";

/** Recomputes fit scores after the user changed their profile or documents. */
export const POST = route(async () => {
  const user = await requireUser();
  rateLimit("jobs-rematch", user.id, 6, 60_000);
  return json(await rematchAll(user));
});
