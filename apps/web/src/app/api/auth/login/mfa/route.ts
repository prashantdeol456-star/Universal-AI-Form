import type { NextRequest } from "next/server";
import { z } from "zod";
import { completeMfaChallenge } from "@/server/auth/mfa";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { notifyNewDevice } from "@/server/notifications";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  mfaToken: z.string().min(20).max(200),
  code: z.string().trim().min(6).max(20),
  client: z.enum(["web", "extension"]).default("web"),
});

/** Second sign-in step: authenticator code (or a recovery code) → session. */
export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  rateLimit("login-mfa-ip", ip, 30, 15 * 60_000);
  const { mfaToken, code, client } = await parseBody(req, bodySchema);
  const userAgent = req.headers.get("user-agent");
  const { userId } = await completeMfaChallenge(mfaToken, code, { ip, userAgent });
  await notifyNewDevice(userId, userAgent).catch(() => {});
  const s = await createSession({ userId, clientType: client, userAgent, ip });
  if (client === "extension") return json({ ok: true, token: s.token, expiresAt: s.expiresAt.toISOString() });
  await setSessionCookie(s.token, s.expiresAt);
  return json({ ok: true });
});
