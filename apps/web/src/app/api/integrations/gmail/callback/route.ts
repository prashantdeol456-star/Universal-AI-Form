import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { clientIp, HttpError, route } from "@/server/http";
import { finishGmailConnect } from "@/server/messaging/gmail";

/**
 * Google redirects here after consent. The state must belong to the signed-in user (checked
 * in finishGmailConnect). The browser only ever sees a redirect back to the dashboard.
 */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const p = req.nextUrl.searchParams;
  const back = new URL("/dashboard/messages", env().APP_URL);
  try {
    await finishGmailConnect(user, { state: p.get("state"), code: p.get("code"), error: p.get("error") }, clientIp(req));
    back.searchParams.set("gmail", "connected");
  } catch (err) {
    back.searchParams.set("gmail", "error");
    back.searchParams.set("reason", err instanceof HttpError ? err.code : "failed");
  }
  return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});
