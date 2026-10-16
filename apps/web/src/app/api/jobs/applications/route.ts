import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { listApplications } from "@/server/jobs/service";

/** Application tracker: everything the user tracks, nearest deadline or follow-up first. */
export const GET = route(async () => {
  const user = await requireUser();
  return json({ applications: await listApplications(user) }, { headers: { "Cache-Control": "no-store" } });
});
