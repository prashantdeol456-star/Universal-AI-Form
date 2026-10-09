import { sendEmailVerification } from "@/server/auth/service";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";

export const POST = route(async () => {
  const user = await requireUser();
  rateLimit("verify-email-resend", user.id, 3, 15 * 60_000);
  await sendEmailVerification(user.id);
  return json({ ok: true });
});
