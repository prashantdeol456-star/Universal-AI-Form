import { requireUser } from "@/server/auth/session";
import { listConflicts } from "@/server/documents/service";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser("profile:read_own");
  return json({ conflicts: await listConflicts(user) }, { headers: { "Cache-Control": "no-store" } });
});
