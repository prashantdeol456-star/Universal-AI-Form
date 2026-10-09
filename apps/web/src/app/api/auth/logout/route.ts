import { audit } from "@/server/audit";
import { clearSessionCookie, getCurrentUser, revokeSession } from "@/server/auth/session";
import { json, route } from "@/server/http";

export const POST = route(async () => {
  const user = await getCurrentUser();
  if (user) {
    await revokeSession(user.sessionId);
    await audit({ actorId: user.id, actorRole: user.role, action: "auth.logout", targetType: "session", targetId: user.sessionId, subjectUserId: user.id });
  }
  await clearSessionCookie();
  return json({ ok: true });
});
