import type { NextRequest } from "next/server";
import { verifyEmailSchema } from "@ufa/shared";
import { verifyEmail } from "@/server/auth/service";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("verify-email", user.id, 10, 15 * 60_000);
  const { code } = await parseBody(req, verifyEmailSchema);
  await verifyEmail(user.id, code);
  return json({ ok: true });
});
