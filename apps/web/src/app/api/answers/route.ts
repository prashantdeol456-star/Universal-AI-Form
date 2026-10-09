import { listSavedAnswers } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser("profile:read_own");
  return json({ answers: await listSavedAnswers(user) }, { headers: { "Cache-Control": "no-store" } });
});
