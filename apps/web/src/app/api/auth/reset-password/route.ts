import type { NextRequest } from "next/server";
import { resetPasswordSchema } from "@ufa/shared";
import { resetPassword } from "@/server/auth/service";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  rateLimit("reset", ip, 10, 60 * 60_000);
  const { token, password } = await parseBody(req, resetPasswordSchema);
  await resetPassword(token, password, { ip, userAgent: req.headers.get("user-agent") });
  return json({ ok: true });
});
