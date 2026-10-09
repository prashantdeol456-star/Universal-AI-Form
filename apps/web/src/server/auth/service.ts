import "server-only";
import type { LoginInput, SignupInput } from "@ufa/shared";
import {
  generateOtp,
  generateToken,
  getDummyHash,
  hashPassword,
  hmacSha256,
  needsRehash,
  safeEqual,
  sha256,
  verifyPassword,
} from "@ufa/security";
import { audit } from "../audit";
import { db } from "../db";
import { env } from "../env";
import { badRequest, conflict, HttpError, unauthorized } from "../http";
import { sendMail } from "../mailer";

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const OTP_TTL_MIN = 15;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TTL_MIN = 30;

interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

function otpHash(userId: string, code: string) {
  return hmacSha256(env().AUTH_SECRET, `${userId}:${code}`);
}

export async function signup(input: SignupInput, meta: RequestMeta): Promise<{ userId: string; role: string }> {
  const sql = db().system;
  const passwordHash = await hashPassword(input.password);

  const userId = await sql.begin(async (tx) => {
    const [existing] = await tx`select id from users where email = ${input.email}`;
    if (existing) throw conflict("An account with this email already exists. Try signing in.");

    const [user] = await tx<{ id: string }[]>`
      insert into users (email, full_name, password_hash, role)
      values (${input.email}, ${input.fullName}, ${passwordHash}, ${input.accountType})
      returning id`;
    const id = user!.id;
    await tx`insert into profiles (user_id) values (${id})`;
    // The user typed these themselves, so they start as verified profile values.
    await tx`
      insert into profile_fields (user_id, field_key, value, source, verified, confidence, updated_by, last_verified_at)
      values (${id}, 'personal.full_name', ${input.fullName}, 'user_input', true, 1, ${id}, now()),
             (${id}, 'contact.email', ${input.email}, 'user_input', true, 1, ${id}, now())`;
    await tx`
      insert into profile_field_history (user_id, field_key, new_value, new_source, change_type, change_reason, changed_by)
      values (${id}, 'personal.full_name', ${input.fullName}, 'user_input', 'CREATE', 'signup', ${id}),
             (${id}, 'contact.email', ${input.email}, 'user_input', 'CREATE', 'signup', ${id})`;
    await audit({ actorId: id, actorRole: input.accountType, action: "auth.signup", targetType: "user", targetId: id, subjectUserId: id, ip: meta.ip, userAgent: meta.userAgent }, tx);
    return id;
  });

  // The account already exists at this point; a mail outage must not turn signup into an error.
  // The user can request a new code from the dashboard banner.
  try {
    await sendEmailVerification(userId);
  } catch (err) {
    console.error(`[auth] verification email failed for new user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { userId, role: input.accountType };
}

export async function sendEmailVerification(userId: string): Promise<void> {
  const sql = db().system;
  const [user] = await sql<{ email: string; email_verified_at: Date | null }[]>`select email, email_verified_at from users where id = ${userId}`;
  if (!user || user.email_verified_at) return;
  const code = generateOtp(6);
  await sql.begin(async (tx) => {
    await tx`update auth_tokens set consumed_at = now() where user_id = ${userId} and purpose = 'EMAIL_VERIFY' and consumed_at is null`;
    await tx`insert into auth_tokens (user_id, purpose, token_hash, expires_at)
             values (${userId}, 'EMAIL_VERIFY', ${otpHash(userId, code)}, now() + make_interval(mins => ${OTP_TTL_MIN}))`;
  });
  await sendMail({
    to: user.email,
    subject: "Your verification code",
    text: `Your Universal AI Form Assistant verification code is ${code}.\n\nIt expires in ${OTP_TTL_MIN} minutes. If you did not create an account, ignore this email.`,
  });
}

export async function verifyEmail(userId: string, code: string): Promise<void> {
  const sql = db().system;
  await sql.begin(async (tx) => {
    const [tok] = await tx<{ id: string; token_hash: string; attempts: number }[]>`
      select id, token_hash, attempts from auth_tokens
       where user_id = ${userId} and purpose = 'EMAIL_VERIFY' and consumed_at is null and expires_at > now()
       order by created_at desc limit 1 for update`;
    if (!tok) throw badRequest("Code expired. Request a new one.");
    if (tok.attempts >= OTP_MAX_ATTEMPTS) throw badRequest("Too many wrong attempts. Request a new code.");
    if (!safeEqual(tok.token_hash, otpHash(userId, code))) {
      await tx`update auth_tokens set attempts = attempts + 1 where id = ${tok.id}`;
      throw badRequest("Incorrect code");
    }
    await tx`update auth_tokens set consumed_at = now() where id = ${tok.id}`;
    await tx`update users set email_verified_at = now() where id = ${userId}`;
    await audit({ actorId: userId, action: "auth.email_verified", targetType: "user", targetId: userId, subjectUserId: userId }, tx);
  });
}

interface LoginRow {
  id: string;
  password_hash: string | null;
  role: string;
  status: string;
  locked_until: Date | null;
  failed_login_count: number;
}

const GENERIC_LOGIN_ERROR = "Incorrect email or password";

export async function login(input: LoginInput, meta: RequestMeta): Promise<{ userId: string }> {
  const sql = db().system;
  const [user] = await sql<LoginRow[]>`
    select id, password_hash, role, status, locked_until, failed_login_count
      from users where email = ${input.email} and deleted_at is null`;

  if (!user || !user.password_hash) {
    await verifyPassword(input.password, await getDummyHash()); // equalize timing
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (user.locked_until && user.locked_until > new Date()) {
    throw new HttpError(423, "locked", "Account temporarily locked after repeated failed sign-ins. Try again later or reset your password.");
  }

  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) {
    const failures = user.failed_login_count + 1;
    await sql`
      update users set failed_login_count = ${failures},
             locked_until = ${failures >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null}
       where id = ${user.id}`;
    await audit({ actorId: null, action: "auth.login_failed", targetType: "user", targetId: user.id, subjectUserId: user.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { failures } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (user.status !== "ACTIVE") throw new HttpError(403, "account_inactive", "This account is not active.");

  const rehash = needsRehash(user.password_hash) ? await hashPassword(input.password) : null;
  await sql`
    update users set failed_login_count = 0, locked_until = null, last_login_at = now()
           ${rehash ? sql`, password_hash = ${rehash}` : sql``}
     where id = ${user.id}`;
  await audit({ actorId: user.id, actorRole: user.role, action: "auth.login", targetType: "session", subjectUserId: user.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { client: input.client } });
  return { userId: user.id };
}

/** Always resolves successfully so the response does not reveal whether the email exists. */
export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
  const sql = db().system;
  const [user] = await sql<{ id: string }[]>`select id from users where email = ${email} and deleted_at is null and status = 'ACTIVE'`;
  if (!user) return;
  const token = generateToken(32);
  await sql.begin(async (tx) => {
    await tx`update auth_tokens set consumed_at = now() where user_id = ${user.id} and purpose = 'PASSWORD_RESET' and consumed_at is null`;
    await tx`insert into auth_tokens (user_id, purpose, token_hash, expires_at)
             values (${user.id}, 'PASSWORD_RESET', ${sha256(token)}, now() + make_interval(mins => ${RESET_TTL_MIN}))`;
  });
  await audit({ actorId: null, action: "auth.password_reset_requested", targetType: "user", targetId: user.id, subjectUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  const link = `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: "Reset your password",
    text: `Use this link to reset your password (valid for ${RESET_TTL_MIN} minutes):\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
  });
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const sql = db().system;
  const hash = await hashPassword(newPassword);
  await sql.begin(async (tx) => {
    const [tok] = await tx<{ id: string; user_id: string }[]>`
      select id, user_id from auth_tokens
       where token_hash = ${sha256(token)} and purpose = 'PASSWORD_RESET'
         and consumed_at is null and expires_at > now()
       for update`;
    if (!tok) throw badRequest("This reset link is invalid or has expired.");
    await tx`update auth_tokens set consumed_at = now() where id = ${tok.id}`;
    // Following the e-mailed link also proves the address (this is how invited operators verify).
    await tx`update users set password_hash = ${hash}, failed_login_count = 0, locked_until = null,
                              email_verified_at = coalesce(email_verified_at, now()) where id = ${tok.user_id}`;
    // Sign out everywhere: a reset usually means the old password may be compromised.
    await tx`update auth_sessions set revoked_at = now() where user_id = ${tok.user_id} and revoked_at is null`;
    await audit({ actorId: tok.user_id, action: "auth.password_reset", targetType: "user", targetId: tok.user_id, subjectUserId: tok.user_id, ip: meta.ip, userAgent: meta.userAgent }, tx);
  });
}

export async function changePassword(userId: string, currentSessionId: string, current: string, next: string, meta: RequestMeta) {
  const sql = db().system;
  const [user] = await sql<{ password_hash: string | null; role: string }[]>`select password_hash, role from users where id = ${userId}`;
  if (!user?.password_hash || !(await verifyPassword(current, user.password_hash))) {
    throw badRequest("Current password is incorrect");
  }
  const hash = await hashPassword(next);
  await sql.begin(async (tx) => {
    await tx`update users set password_hash = ${hash} where id = ${userId}`;
    await tx`update auth_sessions set revoked_at = now() where user_id = ${userId} and id <> ${currentSessionId} and revoked_at is null`;
    await audit({ actorId: userId, actorRole: user.role, action: "auth.password_changed", targetType: "user", targetId: userId, subjectUserId: userId, ip: meta.ip, userAgent: meta.userAgent }, tx);
  });
}
