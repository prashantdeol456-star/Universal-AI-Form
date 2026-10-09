import { requireUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  const rows = await asUser(user, (tx) => tx<{ id: string; client_type: string; user_agent: string | null; ip_address: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }[]>`
    select id, client_type, user_agent, ip_address, created_at, last_seen_at, expires_at from auth_sessions
     where user_id = ${user.id} and revoked_at is null and expires_at > now()
     order by last_seen_at desc`);
  return json({
    sessions: rows.map((r) => ({
      id: r.id,
      clientType: r.client_type,
      userAgent: r.user_agent,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      current: r.id === user.sessionId,
    })),
  });
});
