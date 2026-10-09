import { requireUser } from "@/server/auth/session";
import { listSessions } from "@/server/chat/service";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser("chat:use");
  return json({ sessions: await listSessions(user) }, { headers: { "Cache-Control": "no-store" } });
});
