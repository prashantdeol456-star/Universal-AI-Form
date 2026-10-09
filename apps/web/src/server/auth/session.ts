import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, type Permission, type UserRole } from "@ufa/shared";
import { generateToken, sha256 } from "@ufa/security";
import { db } from "../db";
import { env, isProduction } from "../env";
import { forbidden, unauthorized } from "../http";

export const SESSION_COOKIE = "ufa_session";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  emailVerified: boolean;
  sessionId: string;
  clientType: "web" | "extension";
  /** Two-step verification is on (required for admin features). */
  mfaEnabled: boolean;
  /** Set while the account is scheduled for permanent deletion. */
  deletionScheduledFor: string | null;
}

export async function createSession(opts: {
  userId: string;
  clientType: "web" | "extension";
  userAgent: string | null;
  ip: string;
}): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * 86_400_000);
  const [row] = await db().system<{ id: string }[]>`
    insert into auth_sessions (user_id, token_hash, client_type, user_agent, ip_address, expires_at)
    values (${opts.userId}, ${sha256(token)}, ${opts.clientType}, ${opts.userAgent?.slice(0, 300) ?? null}, ${opts.ip}, ${expiresAt})
    returning id`;
  return { token, expiresAt, sessionId: row!.id };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

interface SessionRow {
  session_id: string;
  client_type: "web" | "extension";
  last_seen_at: Date;
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  email_verified_at: Date | null;
  mfa_enabled_at: Date | null;
  deletion_scheduled_for: Date | null;
}

async function lookup(token: string): Promise<SessionUser | null> {
  const sql = db().system;
  const [row] = await sql<SessionRow[]>`
    select s.id as session_id, s.client_type, s.last_seen_at,
           u.id, u.email, u.full_name, u.role, u.email_verified_at, u.mfa_enabled_at, u.deletion_scheduled_for
      from auth_sessions s
      join users u on u.id = s.user_id
     where s.token_hash = ${sha256(token)}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.status = 'ACTIVE'
       and u.deleted_at is null`;
  if (!row) return null;
  // Touch at most every 5 minutes to avoid a write per request.
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await sql`update auth_sessions set last_seen_at = now() where id = ${row.session_id}`;
  }
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    emailVerified: row.email_verified_at !== null,
    sessionId: row.session_id,
    clientType: row.client_type,
    mfaEnabled: row.mfa_enabled_at !== null,
    deletionScheduledFor: row.deletion_scheduled_for?.toISOString() ?? null,
  };
}

/**
 * Resolves the current user from the session cookie (web) or an
 * `Authorization: Bearer` token (Chrome extension). Cached per request.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const auth = (await headers()).get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return token ? lookup(token) : null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? lookup(token) : null;
});

/** API guard. Throws 401/403 HttpErrors. */
export async function requireUser(permission?: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  if (permission && !can(user.role, permission)) throw forbidden();
  if (permission && adminNeedsMfa(permission, user)) throw forbidden("Turn on two-step verification (Settings) to use admin features");
  return user;
}

/** Admin features need a second factor (ADMIN_REQUIRE_MFA, on by default). */
function adminNeedsMfa(permission: Permission, user: SessionUser): boolean {
  return permission.startsWith("admin:") && env().ADMIN_REQUIRE_MFA && !user.mfaEnabled;
}

/** Page guard. Redirects to login instead of throwing. */
export async function requirePageUser(permission?: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (permission && !can(user.role, permission)) redirect("/dashboard");
  if (permission && adminNeedsMfa(permission, user)) redirect("/dashboard/settings?mfa=required#security");
  return user;
}

export async function revokeSession(sessionId: string) {
  await db().system`update auth_sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`;
}
