import "server-only";
import type { UserRole } from "@ufa/shared";
import { audit } from "../audit";
import { db, type Actor } from "../db";
import { badRequest, forbidden, notFound } from "../http";
import { assertAdmin } from "./guard";

/**
 * User administration: account metadata and counts only. An admin can suspend,
 * reactivate, sign a user out everywhere, or switch between non-admin roles —
 * never read a user's profile, documents, applications' values or chats, and
 * never create another admin from the UI (that stays a server CLI step).
 */

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listUsers(actor: Actor, f: { q?: string; role?: string; status?: string; page?: number } = {}) {
  assertAdmin(actor, "admin:users_view");
  const sql = db().system;
  const pageSize = 25;
  const page = Math.max(1, f.page ?? 1);
  const like = f.q?.trim() ? `%${escapeLike(f.q.trim().slice(0, 100))}%` : null;
  const where = sql`
    deleted_at is null
    ${like ? sql`and (email ilike ${like} or full_name ilike ${like})` : sql``}
    ${f.role ? sql`and role = ${f.role}` : sql``}
    ${f.status ? sql`and status = ${f.status}` : sql``}`;
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from users where ${where}`;
  const rows = await sql<{ id: string; email: string; full_name: string; role: UserRole; status: string; email_verified_at: Date | null; created_at: Date; last_login_at: Date | null }[]>`
    select id, email, full_name, role, status, email_verified_at, created_at, last_login_at
      from users where ${where} order by created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`;
  return {
    total: count!.n,
    page,
    pageSize,
    users: rows.map((r): AdminUserRow => ({
      id: r.id, email: r.email, fullName: r.full_name, role: r.role, status: r.status, emailVerified: r.email_verified_at !== null,
      createdAt: r.created_at.toISOString(), lastLoginAt: r.last_login_at?.toISOString() ?? null,
    })),
  };
}

export interface AdminUserDetail extends AdminUserRow {
  counts: { profileFields: number; documents: number; applications: number; activeSessions: number; cafeSessions: number };
  cafes: Array<{ id: string; name: string; role: string; status: string }>;
  activity: Array<{ action: string; at: string; byAdmin: boolean }>;
}

export async function getUser(actor: Actor, id: string): Promise<AdminUserDetail> {
  assertAdmin(actor, "admin:users_view");
  const sql = db().system;
  const [r] = await sql<{ id: string; email: string; full_name: string; role: UserRole; status: string; email_verified_at: Date | null; created_at: Date; last_login_at: Date | null }[]>`
    select id, email, full_name, role, status, email_verified_at, created_at, last_login_at from users where id = ${id} and deleted_at is null`;
  if (!r) throw notFound("User not found");
  // Counts only — never the rows themselves.
  const [c] = await sql<{ fields: number; docs: number; apps: number; sessions: number; cafe: number }[]>`
    select (select count(*)::int from profile_fields where user_id = ${id} and deleted_at is null) as fields,
           (select count(*)::int from documents where user_id = ${id} and deleted_at is null) as docs,
           (select count(*)::int from applications where customer_id = ${id}) as apps,
           (select count(*)::int from auth_sessions where user_id = ${id} and revoked_at is null and expires_at > now()) as sessions,
           (select count(*)::int from cafe_sessions where customer_id = ${id}) as cafe`;
  const cafes = await sql<{ id: string; name: string; cafe_role: string; status: string }[]>`
    select c.id, c.name, cu.cafe_role, cu.status from cafe_users cu join cafes c on c.id = cu.cafe_id where cu.user_id = ${id}`;
  const activity = await sql<{ action: string; created_at: Date; actor_role: string | null }[]>`
    select action, created_at, actor_role from audit_logs where subject_user_id = ${id} order by created_at desc limit 20`;
  return {
    id: r.id, email: r.email, fullName: r.full_name, role: r.role, status: r.status, emailVerified: r.email_verified_at !== null,
    createdAt: r.created_at.toISOString(), lastLoginAt: r.last_login_at?.toISOString() ?? null,
    counts: { profileFields: c!.fields, documents: c!.docs, applications: c!.apps, activeSessions: c!.sessions, cafeSessions: c!.cafe },
    cafes: cafes.map((x) => ({ id: x.id, name: x.name, role: x.cafe_role, status: x.status })),
    activity: activity.map((x) => ({ action: x.action, at: x.created_at.toISOString(), byAdmin: x.actor_role === "SUPER_ADMIN" })),
  };
}

const ASSIGNABLE: UserRole[] = ["CUSTOMER", "CAFE_OWNER", "CAFE_OPERATOR"];

export type UserAction = { action: "suspend" | "reactivate" | "revoke_sessions" } | { action: "set_role"; role: UserRole };

export async function adminUserAction(actor: Actor, id: string, a: UserAction, reason: string, ip?: string) {
  assertAdmin(actor, "admin:users_view");
  if (id === actor.id) throw forbidden("You cannot change your own account here");
  if (!reason.trim()) throw badRequest("Give a reason (it is kept in the audit log)");
  const sql = db().system;
  const [u] = await sql<{ role: UserRole; status: string }[]>`select role, status from users where id = ${id} and deleted_at is null`;
  if (!u) throw notFound("User not found");
  if (u.role === "SUPER_ADMIN") throw forbidden("Administrators are managed with the server CLI");

  await sql.begin(async (tx) => {
    if (a.action === "suspend") {
      await tx`update users set status = 'SUSPENDED' where id = ${id}`;
      // Signed out everywhere at once; café access they hold ends too.
      await tx`update auth_sessions set revoked_at = now() where user_id = ${id} and revoked_at is null`;
      await tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
                where operator_id = ${id} and status in ('ACTIVE', 'PENDING')`;
    } else if (a.action === "reactivate") {
      await tx`update users set status = 'ACTIVE', failed_login_count = 0, locked_until = null where id = ${id}`;
    } else if (a.action === "revoke_sessions") {
      await tx`update auth_sessions set revoked_at = now() where user_id = ${id} and revoked_at is null`;
    } else if (a.action === "set_role") {
      if (!ASSIGNABLE.includes(a.role)) throw badRequest("This role cannot be assigned here");
      await tx`update users set role = ${a.role} where id = ${id}`;
      await tx`update auth_sessions set revoked_at = now() where user_id = ${id} and revoked_at is null`;
    }
    await audit(
      {
        actorId: actor.id, actorRole: actor.role, action: `admin.user_${a.action}`, targetType: "user", targetId: id, subjectUserId: id, ip,
        metadata: { reason: reason.trim().slice(0, 300), ...(a.action === "set_role" ? { from: u.role, to: a.role } : {}) },
      },
      tx,
    );
  });
  return { saved: true as const };
}
