import type { NextRequest } from "next/server";
import { loginSchema } from "@ufa/shared";
import { createMfaChallenge, needsSecondFactor } from "@/server/auth/mfa";
import { notifyNewDevice } from "@/server/notifications";
import { login } from "@/server/auth/service";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  rateLimit("login-ip", ip, 30, 15 * 60_000);
  const input = await parseBody(req, loginSchema);
  rateLimit("login-email", input.email, 10, 15 * 60_000);
  const userAgent = req.headers.get("user-agent");
  const { userId } = await login(input, { ip, userAgent });
  // Two-step verification: no session until the authenticator code is checked (POST /api/auth/login/mfa).
  if (await needsSecondFactor(userId)) {
    return json({ ok: false, mfaRequired: true, mfaToken: await createMfaChallenge(userId) });
  }
  await notifyNewDevice(userId, userAgent).catch(() => {});
  const s = await createSession({ userId, clientType: input.client, userAgent, ip });
  if (input.client === "extension") {
    // The extension stores the opaque token and sends it as a Bearer header.
    return json({ ok: true, token: s.token, expiresAt: s.expiresAt.toISOString() });
  }
  await setSessionCookie(s.token, s.expiresAt);
  return json({ ok: true });
});
