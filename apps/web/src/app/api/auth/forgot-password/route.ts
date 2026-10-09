import type { NextRequest } from "next/server";
import { forgotPasswordSchema } from "@ufa/shared";
import { requestPasswordReset } from "@/server/auth/service";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  rateLimit("forgot-ip", ip, 10, 60 * 60_000);
  const { email } = await parseBody(req, forgotPasswordSchema);
  rateLimit("forgot-email", email, 3, 60 * 60_000);
  await requestPasswordReset(email, { ip, userAgent: req.headers.get("user-agent") });
  // Same response whether or not the account exists.
  return json({ ok: true, message: "If an account exists for this email, a reset link has been sent." });
});
