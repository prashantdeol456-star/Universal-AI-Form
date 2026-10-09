import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { cafeSessions } from "@/server/cafe/workspace";
import { json, route } from "@/server/http";

/** Sessions of this café (owner: all; operator: own). ?active=1 for the ones usable right now. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:sessions_request");
  const sessions = await cafeSessions(user, { activeOnly: req.nextUrl.searchParams.get("active") === "1" });
  return json({ sessions }, { headers: { "Cache-Control": "no-store" } });
});
