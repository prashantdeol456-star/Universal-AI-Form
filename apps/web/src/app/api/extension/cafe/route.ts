import { can } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { cafeSessions, myCafe } from "@/server/cafe/workspace";
import { json, route } from "@/server/http";

/** Side panel: is this a café account, and which customers can it fill for right now? */
export const GET = route(async () => {
  const user = await requireUser();
  if (!can(user.role, "cafe:sessions_request")) return json({ cafe: null, sessions: [] });
  const cafe = await myCafe(user);
  if (!cafe) return json({ cafe: null, sessions: [] });
  const sessions = await cafeSessions(user, { activeOnly: true });
  return json(
    {
      cafe: { id: cafe.id, name: cafe.name, myRole: cafe.myRole },
      // Owners see all active sessions of the café but can only fill with their own.
      sessions: sessions
        .filter((s) => s.status === "ACTIVE" && s.operatorId === user.id)
        .map((s) => ({ id: s.id, customerName: s.customerName, purpose: s.purpose, permissions: s.permissions, expiresAt: s.expiresAt })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
