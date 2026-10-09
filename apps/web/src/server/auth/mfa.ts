import "server-only";
import { generateRecoveryCodes, generateToken, generateTotpSecret, safeEqual, sha256, totpUri, verifyPassword, verifyTotp } from "@ufa/security";
import { audit } from "../audit";
import { db, decryptValue, encryptValue } from "../db";
import { badRequest, HttpError, unauthorized } from "../http";

/**
 * Two-step verification with an authenticator app (TOTP, phase 13). Optional
 * for everyone, required for admin features. The secret is stored encrypted,
 * recovery codes only as hashes; the runtime database role cannot read either.
 */
const PENDING_TTL_MIN = 5;
const MAX_ATTEMPTS = 5;
const normalizeRecovery = (c: string) => c.toUpperCase().replace(/[\s-]/g, "");

async function checkPassword(userId: string, password: string) {
  const [u] = await db().system<{ password_hash: string | null }[]>`select password_hash from users where id = ${userId}`;
  if (!u?.password_hash || !(await verifyPassword(password, u.password_hash))) throw badRequest("Password is incorrect");
}

export async function mfaStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const [u] = await db().system<{ mfa_enabled_at: Date | null; mfa_recovery_hashes: string[] }[]>`
    select mfa_enabled_at, mfa_recovery_hashes from users where id = ${userId}`;
  return { enabled: Boolean(u?.mfa_enabled_at), recoveryCodesLeft: u?.mfa_recovery_hashes.length ?? 0 };
}

/** Step 1: a new secret for the authenticator app (not active until confirmed with a code). */
export async function startMfaSetup(userId: string, email: string): Promise<{ secret: string; uri: string }> {
  const [u] = await db().system<{ mfa_enabled_at: Date | null }[]>`select mfa_enabled_at from users where id = ${userId}`;
  if (u?.mfa_enabled_at) throw badRequest("Two-step verification is already on");
  const secret = generateTotpSecret();
  await db().system`update users set mfa_totp_secret = ${encryptValue(secret)} where id = ${userId}`;
  return { secret, uri: totpUri(secret, email) };
}

/** Step 2: prove the app works (code) and that it is you (password); returns one-time recovery codes. */
export async function enableMfa(userId: string, role: string, password: string, code: string, ip?: string): Promise<{ recoveryCodes: string[] }> {
  await checkPassword(userId, password);
  const [u] = await db().system<{ mfa_totp_secret: string | null; mfa_enabled_at: Date | null }[]>`
    select mfa_totp_secret, mfa_enabled_at from users where id = ${userId}`;
  if (u?.mfa_enabled_at) throw badRequest("Two-step verification is already on");
  if (!u?.mfa_totp_secret) throw badRequest("Start the setup first");
  if (verifyTotp(decryptValue(u.mfa_totp_secret), code) === null) throw badRequest("That code is not right. Check the time on your phone and try the newest code.");
  const codes = generateRecoveryCodes();
  await db().system.begin(async (tx) => {
    await tx`update users set mfa_enabled_at = now(), mfa_recovery_hashes = ${codes.map((c) => sha256(normalizeRecovery(c)))} where id = ${userId}`;
    await audit({ actorId: userId, actorRole: role, action: "auth.mfa_enabled", targetType: "user", targetId: userId, subjectUserId: userId, ip }, tx);
  });
  return { recoveryCodes: codes };
}

export async function disableMfa(userId: string, role: string, password: string, code: string, ip?: string) {
  await checkPassword(userId, password);
  if (!(await checkSecondFactor(userId, code))) throw badRequest("That code is not right");
  await db().system.begin(async (tx) => {
    await tx`update users set mfa_enabled_at = null, mfa_totp_secret = null, mfa_recovery_hashes = '{}' where id = ${userId}`;
    await audit({ actorId: userId, actorRole: role, action: "auth.mfa_disabled", targetType: "user", targetId: userId, subjectUserId: userId, ip }, tx);
  });
  return { disabled: true as const };
}

/** A TOTP code, or a recovery code (which is then used up). */
async function checkSecondFactor(userId: string, code: string): Promise<boolean> {
  const [u] = await db().system<{ mfa_totp_secret: string | null; mfa_recovery_hashes: string[] }[]>`
    select mfa_totp_secret, mfa_recovery_hashes from users where id = ${userId} and mfa_enabled_at is not null`;
  if (!u?.mfa_totp_secret) return false;
  if (/^\d{6}$/.test(code.replace(/\s/g, ""))) return verifyTotp(decryptValue(u.mfa_totp_secret), code) !== null;
  const h = sha256(normalizeRecovery(code));
  const match = u.mfa_recovery_hashes.find((x) => safeEqual(x, h));
  if (!match) return false;
  await db().system`update users set mfa_recovery_hashes = array_remove(mfa_recovery_hashes, ${match}) where id = ${userId}`;
  return true;
}

export async function needsSecondFactor(userId: string): Promise<boolean> {
  return (await mfaStatus(userId)).enabled;
}

/** After a correct password: a short-lived token the client exchanges together with the code. */
export async function createMfaChallenge(userId: string): Promise<string> {
  const token = generateToken(32);
  await db().system`
    insert into auth_tokens (user_id, purpose, token_hash, expires_at)
    values (${userId}, 'MFA_PENDING', ${sha256(token)}, now() + make_interval(mins => ${PENDING_TTL_MIN}))`;
  return token;
}

/** Exchanges the challenge + code for the user id (then the caller creates the session). */
export async function completeMfaChallenge(token: string, code: string, meta: { ip: string; userAgent: string | null }): Promise<{ userId: string; role: string }> {
  const sql = db().system;
  const [tok] = await sql<{ id: string; user_id: string; attempts: number; role: string; status: string }[]>`
    select t.id, t.user_id, t.attempts, u.role, u.status from auth_tokens t join users u on u.id = t.user_id
     where t.token_hash = ${sha256(token)} and t.purpose = 'MFA_PENDING' and t.consumed_at is null and t.expires_at > now()`;
  if (!tok || tok.status !== "ACTIVE") throw unauthorized("Sign-in expired. Enter your password again.");
  if (tok.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts", "Too many wrong codes. Sign in again.");
  if (!(await checkSecondFactor(tok.user_id, code))) {
    await sql`update auth_tokens set attempts = attempts + 1 where id = ${tok.id}`;
    await audit({ actorId: null, action: "auth.mfa_failed", targetType: "user", targetId: tok.user_id, subjectUserId: tok.user_id, ip: meta.ip, userAgent: meta.userAgent });
    throw unauthorized("That code is not right");
  }
  await sql`update auth_tokens set consumed_at = now() where id = ${tok.id}`;
  await audit({ actorId: tok.user_id, actorRole: tok.role, action: "auth.mfa_verified", targetType: "session", subjectUserId: tok.user_id, ip: meta.ip, userAgent: meta.userAgent });
  return { userId: tok.user_id, role: tok.role };
}
