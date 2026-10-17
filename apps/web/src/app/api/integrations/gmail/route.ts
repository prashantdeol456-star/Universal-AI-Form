import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";
import { gmailStatus, setGmailCloudAi } from "@/server/messaging/gmail";
import { cloudSchema } from "@/server/messaging/schemas";

/** Connection status (never tokens). */
export const GET = route(async () => {
  const user = await requireUser();
  return json(await gmailStatus(user), { headers: { "Cache-Control": "no-store" } });
});

/** Per-mailbox consent for cloud AI (off by default). */
export const PATCH = route(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(req, cloudSchema);
  return json(await setGmailCloudAi(user, body.cloudAiAllowed, clientIp(req)));
});
