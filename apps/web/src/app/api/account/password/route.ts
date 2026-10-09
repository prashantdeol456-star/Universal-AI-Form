import type { NextRequest } from "next/server";
import { changePasswordSchema } from "@ufa/shared";
import { changePassword } from "@/server/auth/service";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("change-password", user.id, 5, 15 * 60_000);
  const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema);
  await changePassword(user.id, user.sessionId, currentPassword, newPassword, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  return json({ ok: true });
});
