import type { NextRequest } from "next/server";
import { signupSchema } from "@ufa/shared";
import { signup } from "@/server/auth/service";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  rateLimit("signup", ip, 5, 60 * 60_000);
  const input = await parseBody(req, signupSchema);
  const userAgent = req.headers.get("user-agent");
  const { userId } = await signup(input, { ip, userAgent });
  const s = await createSession({ userId, clientType: "web", userAgent, ip });
  await setSessionCookie(s.token, s.expiresAt);
  return json({ ok: true, emailVerificationRequired: true }, { status: 201 });
});
