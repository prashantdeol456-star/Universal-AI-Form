import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, route } from "@/server/http";
import { disconnectGmail } from "@/server/messaging/gmail";

/** Revokes access at Google and deletes the connection, summaries and local drafts. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  return json(await disconnectGmail(user, clientIp(req)));
});
