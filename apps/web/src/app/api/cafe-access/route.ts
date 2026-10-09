import { requireUser } from "@/server/auth/session";
import { myCafeAccess } from "@/server/cafe/customer";
import { json, route } from "@/server/http";

/** The customer's café requests, active sessions, codes and café access log. */
export const GET = route(async () => {
  const user = await requireUser("privacy:manage_own");
  return json(await myCafeAccess(user), { headers: { "Cache-Control": "no-store" } });
});
