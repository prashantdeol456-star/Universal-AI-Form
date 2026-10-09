import "server-only";
import { audit } from "../audit";
import { db, type Actor } from "../db";
import { badRequest, notFound } from "../http";
import { assertAdmin } from "./guard";

/** Café oversight: who runs which café, how busy it is, and suspending it if it is abused. */
export interface AdminCafeRow {
  id: string;
  name: string;
  city: string | null;
  status: string;
  ownerName: string;
  ownerEmail: string;
  operators: number;
  activeSessions: number;
  sessions30d: number;
  forms30d: number;
  createdAt: string;
}

export async function listCafes(actor: Actor): Promise<AdminCafeRow[]> {
  assertAdmin(actor, "admin:users_view");
  const rows = await db().system<{
    id: string; name: string; city: string | null; status: string; owner_name: string; owner_email: string; created_at: Date;
    operators: number; active: number; s30: number; f30: number;
  }[]>`
    select c.id, c.name, c.city, c.status, u.full_name as owner_name, u.email as owner_email, c.created_at,
           (select count(*)::int from cafe_users cu where cu.cafe_id = c.id and cu.cafe_role = 'OPERATOR' and cu.status = 'ACTIVE') as operators,
           (select count(*)::int from cafe_sessions s where s.cafe_id = c.id and s.status = 'ACTIVE' and s.expires_at > now()) as active,
           (select count(*)::int from cafe_sessions s where s.cafe_id = c.id and s.created_at >= now() - interval '30 days') as s30,
           (select count(*)::int from applications a where a.cafe_id = c.id and a.created_at >= now() - interval '30 days') as f30
      from cafes c join users u on u.id = c.owner_id
     where c.deleted_at is null
     order by c.created_at desc limit 500`;
  return rows.map((r) => ({
    id: r.id, name: r.name, city: r.city, status: r.status, ownerName: r.owner_name, ownerEmail: r.owner_email,
    operators: r.operators, activeSessions: r.active, sessions30d: r.s30, forms30d: r.f30, createdAt: r.created_at.toISOString(),
  }));
}

/** Suspending a café cuts every customer session at once (RLS checks the café status since 0012). */
export async function setCafeStatus(actor: Actor, id: string, status: "ACTIVE" | "SUSPENDED", reason: string, ip?: string) {
  assertAdmin(actor, "admin:users_view");
  if (!reason.trim()) throw badRequest("Give a reason (it is kept in the audit log)");
  await db().system.begin(async (tx) => {
    const rows = await tx<{ owner_id: string }[]>`update cafes set status = ${status} where id = ${id} and deleted_at is null returning owner_id`;
    if (!rows.length) throw notFound("Café not found");
    if (status === "SUSPENDED") {
      await tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id} where cafe_id = ${id} and status in ('ACTIVE', 'PENDING')`;
    }
    await audit(
      { actorId: actor.id, actorRole: actor.role, action: `admin.cafe_${status === "ACTIVE" ? "reactivated" : "suspended"}`, targetType: "cafe", targetId: id, cafeId: id, subjectUserId: rows[0]!.owner_id, ip, metadata: { reason: reason.trim().slice(0, 300) } },
      tx,
    );
  });
  return { saved: true as const };
}
