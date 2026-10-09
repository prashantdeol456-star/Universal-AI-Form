import "server-only";
import { CAFE_CODE_TTL_MINUTES, CAFE_MAX_SESSION_MINUTES, isCafePermission, type CafePermission } from "@ufa/shared";
import { generateAccessCode, hmacSha256 } from "@ufa/security";
import { audit } from "../audit";
import { asUser, db, type Actor } from "../db";
import { env } from "../env";
import { badRequest, notFound } from "../http";

/**
 * The customer's side of café mode (spec §44–48): see who asked for access,
 * approve with exactly the categories and time they choose, revoke at any time,
 * or hand an operator a one-time code. Every change is audited and shows up in
 * the customer's access log.
 */

export const codeHash = (normalized: string) => hmacSha256(env().AUTH_SECRET, `cafe-code:${normalized}`);

export interface CafeSessionView {
  id: string;
  cafeId: string;
  cafeName: string;
  operatorId: string;
  operatorName: string;
  purpose: string | null;
  status: string;
  permissions: CafePermission[];
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  applications: number;
}

/** Marks sessions whose time is over (RLS already ignores them; this keeps statuses honest). */
export async function expireCafeSessions(): Promise<number> {
  const rows = await db().system`
    update cafe_sessions set status = 'EXPIRED'
     where status in ('ACTIVE', 'PENDING') and expires_at <= now()
    returning id`;
  return rows.length;
}

type SessionRow = {
  id: string;
  cafe_id: string;
  customer_id: string;
  operator_id: string;
  purpose: string | null;
  status: string;
  created_at: Date;
  approved_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
};

/** Names for display. users is not readable across accounts under RLS, so the system pool resolves only the ids we already hold. */
export async function displayNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db().system<{ id: string; full_name: string }[]>`select id, full_name from users where id in ${db().system([...new Set(ids)])}`;
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

export async function cafeNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db().system<{ id: string; name: string }[]>`select id, name from cafes where id in ${db().system([...new Set(ids)])}`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function toSessionViews(tx: Parameters<Parameters<typeof asUser>[1]>[0], rows: SessionRow[]): Promise<CafeSessionView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const perms = await tx<{ cafe_session_id: string; permission: string }[]>`
    select cafe_session_id, permission from cafe_permissions where cafe_session_id in ${tx(ids)}`;
  const apps = await tx<{ cafe_session_id: string; n: number }[]>`
    select cafe_session_id, count(*)::int as n from applications where cafe_session_id in ${tx(ids)} group by 1`;
  const names = await displayNames(rows.map((r) => r.operator_id));
  const cafes = await cafeNames(rows.map((r) => r.cafe_id));
  return rows.map((r) => ({
    id: r.id,
    cafeId: r.cafe_id,
    cafeName: cafes.get(r.cafe_id) ?? "Café",
    operatorId: r.operator_id,
    operatorName: names.get(r.operator_id) ?? "Operator",
    purpose: r.purpose,
    status: r.status === "ACTIVE" && r.expires_at <= new Date() ? "EXPIRED" : r.status,
    permissions: perms.filter((p) => p.cafe_session_id === r.id).map((p) => p.permission).filter(isCafePermission),
    createdAt: r.created_at.toISOString(),
    approvedAt: r.approved_at?.toISOString() ?? null,
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    applications: apps.find((a) => a.cafe_session_id === r.id)?.n ?? 0,
  }));
}

export interface MyCafeAccess {
  pending: CafeSessionView[];
  active: CafeSessionView[];
  past: CafeSessionView[];
  codes: Array<{ id: string; permissions: CafePermission[]; durationMinutes: number; purpose: string | null; expiresAt: string; usedAt: string | null }>;
  log: Array<{ action: string; actorName: string; at: string }>;
}

export async function myCafeAccess(actor: Actor): Promise<MyCafeAccess> {
  await expireCafeSessions();
  return asUser(actor, async (tx) => {
    const rows = await tx<SessionRow[]>`
      select id, cafe_id, customer_id, operator_id, purpose, status, created_at, approved_at, expires_at, revoked_at
        from cafe_sessions where customer_id = ${actor.id} order by created_at desc limit 100`;
    const views = await toSessionViews(tx, rows);
    const codes = await tx<{ id: string; permissions: string[]; duration_minutes: number; purpose: string | null; expires_at: Date; used_at: Date | null }[]>`
      select id, permissions, duration_minutes, purpose, expires_at, used_at from cafe_access_codes
       where customer_id = ${actor.id} and cancelled_at is null and (used_at is null and expires_at > now())
       order by created_at desc`;
    const log = await tx<{ action: string; actor_id: string | null; created_at: Date }[]>`
      select action, actor_id, created_at from audit_logs
       where subject_user_id = ${actor.id} and actor_id is distinct from ${actor.id} and action like 'cafe.%'
       order by created_at desc limit 100`;
    const actorNames = await displayNames(log.map((l) => l.actor_id).filter((x): x is string => Boolean(x)));
    return {
      pending: views.filter((v) => v.status === "PENDING"),
      active: views.filter((v) => v.status === "ACTIVE"),
      past: views.filter((v) => !["PENDING", "ACTIVE"].includes(v.status)),
      codes: codes.map((c) => ({
        id: c.id,
        permissions: c.permissions.filter(isCafePermission),
        durationMinutes: c.duration_minutes,
        purpose: c.purpose,
        expiresAt: c.expires_at.toISOString(),
        usedAt: c.used_at?.toISOString() ?? null,
      })),
      log: log.map((l) => ({ action: l.action, actorName: (l.actor_id && actorNames.get(l.actor_id)) || "Café", at: l.created_at.toISOString() })),
    };
  });
}

const checkDuration = (m: number) => {
  if (!Number.isInteger(m) || m < 15 || m > CAFE_MAX_SESSION_MINUTES) throw badRequest("Choose between 15 minutes and 12 hours");
};

/** Approve a request with the categories (a subset of what was asked) and duration the customer chooses. */
export async function approveSession(actor: Actor, id: string, input: { permissions: string[]; durationMinutes: number }, ip?: string) {
  checkDuration(input.durationMinutes);
  const chosen = [...new Set(input.permissions)].filter(isCafePermission);
  if (!chosen.length) throw badRequest("Choose at least one category, or reject the request");
  await asUser(actor, async (tx) => {
    const [s] = await tx<{ id: string; status: string; cafe_id: string; operator_id: string }[]>`
      select id, status, cafe_id, operator_id from cafe_sessions where id = ${id} and customer_id = ${actor.id} for update`;
    if (!s) throw notFound("Request not found");
    if (s.status !== "PENDING") throw badRequest(`This request is already ${s.status.toLowerCase()}`);
    const requested = (await tx<{ permission: string }[]>`select permission from cafe_permissions where cafe_session_id = ${id}`).map((r) => r.permission);
    const extra = chosen.filter((p) => !requested.includes(p));
    if (extra.length) throw badRequest("You can only allow what the café asked for");
    await tx`delete from cafe_permissions where cafe_session_id = ${id} and not (permission = any(${chosen}))`;
    await tx`update cafe_sessions set status = 'ACTIVE', approved_at = now(), expires_at = now() + make_interval(mins => ${input.durationMinutes}) where id = ${id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.session_approved", targetType: "cafe_session", targetId: id, subjectUserId: actor.id, cafeId: s.cafe_id, ip, metadata: { permissions: chosen, minutes: input.durationMinutes } }, tx);
  });
  return { approved: true as const };
}

export async function rejectSession(actor: Actor, id: string, ip?: string) {
  await asUser(actor, async (tx) => {
    const rows = await tx<{ cafe_id: string }[]>`
      update cafe_sessions set status = 'REJECTED' where id = ${id} and customer_id = ${actor.id} and status = 'PENDING' returning cafe_id`;
    if (!rows.length) throw notFound("Request not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.session_rejected", targetType: "cafe_session", targetId: id, subjectUserId: actor.id, cafeId: rows[0]!.cafe_id, ip }, tx);
  });
  return { rejected: true as const };
}

/** Ends access immediately (the operator's next request fails). */
export async function revokeMySession(actor: Actor, id: string, ip?: string) {
  await asUser(actor, async (tx) => {
    const rows = await tx<{ cafe_id: string }[]>`
      update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
       where id = ${id} and customer_id = ${actor.id} and status in ('ACTIVE', 'PENDING') returning cafe_id`;
    if (!rows.length) throw notFound("Active session not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.session_revoked", targetType: "cafe_session", targetId: id, subjectUserId: actor.id, cafeId: rows[0]!.cafe_id, ip }, tx);
  });
  return { revoked: true as const };
}

/** A one-time code the customer reads to the operator; shown once, stored only as a keyed hash. */
export async function createAccessCode(actor: Actor, input: { permissions: string[]; durationMinutes: number; purpose?: string | null }, ip?: string) {
  checkDuration(input.durationMinutes);
  const permissions = [...new Set(input.permissions)].filter(isCafePermission);
  if (!permissions.length) throw badRequest("Choose at least one category");
  const code = generateAccessCode();
  const expiresAt = new Date(Date.now() + CAFE_CODE_TTL_MINUTES * 60_000);
  await asUser(actor, async (tx) => {
    // One live code at a time keeps things simple for the customer.
    await tx`update cafe_access_codes set cancelled_at = now() where customer_id = ${actor.id} and used_at is null and cancelled_at is null`;
    await tx`
      insert into cafe_access_codes (customer_id, code_hash, permissions, duration_minutes, purpose, expires_at)
      values (${actor.id}, ${codeHash(code.replace("-", ""))}, ${permissions}, ${input.durationMinutes}, ${input.purpose?.trim().slice(0, 200) || null}, ${expiresAt})`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.code_created", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip, metadata: { permissions, minutes: input.durationMinutes } }, tx);
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function cancelAccessCode(actor: Actor, id: string) {
  await asUser(actor, async (tx) => {
    const rows = await tx`update cafe_access_codes set cancelled_at = now() where id = ${id} and customer_id = ${actor.id} and cancelled_at is null returning id`;
    if (!rows.length) throw notFound("Code not found");
  });
  return { cancelled: true as const };
}

const g = globalThis as unknown as { __ufaCafeSweep?: NodeJS.Timeout };

/** Every few minutes, mark sessions whose time is over as EXPIRED (access already ended via RLS). */
export function startCafeMaintenance(intervalMs = 5 * 60_000) {
  if (g.__ufaCafeSweep) return;
  g.__ufaCafeSweep = setInterval(() => void expireCafeSessions().catch(() => {}), intervalMs);
  g.__ufaCafeSweep.unref?.();
}
