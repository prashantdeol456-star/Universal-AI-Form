import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { startGmailConnect } from "@/server/messaging/gmail";
import { connectSchema } from "@/server/messaging/schemas";

/** Starts Google's consent screen for read-only, or read + create drafts. Returns the URL to open. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("gmail-connect", user.id, 10, 10 * 60_000);
  const { access } = await parseBody(req, connectSchema);
  return json(await startGmailConnect(user, access, clientIp(req)), { headers: { "Cache-Control": "no-store" } });
});
