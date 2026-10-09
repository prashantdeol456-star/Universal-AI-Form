import "server-only";
import { eraseUser } from "@ufa/db";
import { sha256, verifyPassword } from "@ufa/security";
import { audit } from "../audit";
import { db, type Actor } from "../db";
import { env } from "../env";
import { badRequest, forbidden } from "../http";
import { sendMail } from "../mailer";
import { notify } from "../notifications";
import { storage } from "../storage";

/**
 * Account deletion (spec "right to erasure", phase 13).
 *
 * Request → immediately: other devices signed out, café access ended, codes
 * cancelled, contributions to shared learning withdrawn. The account stays usable
 * (so the user can cancel) until the grace period ends; then the purge job
 * deletes every row (profile, documents + files, chats, applications incl.
 * snapshots, mappings, sessions) and the e-mail address becomes free again.
 * Audit entries stay, without the link to the person.
 */

export async function requestDeletion(actor: Actor & { sessionId: string; email: string }, password: string, ip?: string) {
  if (actor.role === "SUPER_ADMIN") throw forbidden("Administrator accounts are removed with the server CLI");
  const sql = db().system;
  const [u] = await sql<{ password_hash: string | null; deletion_scheduled_for: Date | null }[]>`
    select password_hash, deletion_scheduled_for from users where id = ${actor.id}`;
  if (!u?.password_hash || !(await verifyPassword(password, u.password_hash))) throw badRequest("Password is incorrect");
  if (u.deletion_scheduled_for) throw badRequest("Deletion is already scheduled");
  const [cafe] = await sql<{ name: string }[]>`select name from cafes where owner_id = ${actor.id} and deleted_at is null`;
  if (cafe) throw badRequest(`You own the café "${cafe.name}". Close it first in Café Workspace.`);

  const days = env().ACCOUNT_DELETION_GRACE_DAYS;
  const [row] = await sql.begin(async (tx) => {
    const r = await tx<{ deletion_scheduled_for: Date }[]>`
      update users set deletion_requested_at = now(), deletion_scheduled_for = now() + make_interval(days => ${days})
       where id = ${actor.id} returning deletion_scheduled_for`;
    // Stop everything that shares or exposes data, right now.
    await tx`update auth_sessions set revoked_at = now() where user_id = ${actor.id} and id <> ${actor.sessionId} and revoked_at is null`;
    await tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
              where (customer_id = ${actor.id} or operator_id = ${actor.id}) and status in ('ACTIVE', 'PENDING')`;
    await tx`update cafe_access_codes set cancelled_at = now() where customer_id = ${actor.id} and used_at is null and cancelled_at is null`;
    await tx`update cafe_users set status = 'DISABLED' where user_id = ${actor.id} and cafe_role = 'OPERATOR'`;
    await tx`update profiles set learning_contribution_enabled = false where user_id = ${actor.id}`;
    await tx`update learning_examples set status = 'REMOVED' where contributor_user_id = ${actor.id} and status <> 'REMOVED'`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "privacy.deletion_requested", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip, metadata: { graceDays: days } }, tx);
    return r;
  });
  const when = row!.deletion_scheduled_for;
  await notify(actor.id, {
    type: "account_deletion",
    title: `Your account will be deleted on ${when.toLocaleDateString("en-IN", { dateStyle: "medium" })}`,
    body: "You can cancel until then from Privacy & Access. Download your data first if you want a copy.",
    link: "/dashboard/privacy#delete",
  }).catch(() => {});
  await sendMail({
    to: actor.email,
    subject: "Your account is scheduled for deletion",
    text: `You asked us to delete your Universal AI Form Assistant account.\n\nIt will be permanently deleted on ${when.toUTCString()}. Until then you can sign in and cancel from Privacy & Access.\n\nIf this was not you, sign in, cancel, and change your password.`,
  }).catch(() => {});
  return { scheduledFor: when.toISOString() };
}

export async function cancelDeletion(actor: Actor, ip?: string) {
  const rows = await db().system`
    update users set deletion_requested_at = null, deletion_scheduled_for = null
     where id = ${actor.id} and deletion_scheduled_for is not null returning id`;
  if (!rows.length) throw badRequest("No deletion is scheduled");
  await audit({ actorId: actor.id, actorRole: actor.role, action: "privacy.deletion_cancelled", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip });
  return { cancelled: true as const };
}

/** Permanently deletes accounts whose grace period is over. Safe to run repeatedly. */
export async function purgeDueAccounts(limit = 20): Promise<number> {
  const sql = db().system;
  const due = await sql<{ id: string }[]>`
    select id from users where deletion_scheduled_for is not null and deletion_scheduled_for <= now() and role <> 'SUPER_ADMIN'
     order by deletion_scheduled_for limit ${limit}`;
  let done = 0;
  for (const { id } of due) {
    try {
      const { storageKeys: keys } = await eraseUser(sql, id);
      for (const k of keys) await storage().delete(k).catch(() => {});
      done++;
    } catch (err) {
      console.error(`[privacy] purge of ${sha256(id).slice(0, 12)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (done) console.info(`[privacy] permanently deleted ${done} account(s)`);
  return done;
}

const g = globalThis as unknown as { __ufaPurge?: NodeJS.Timeout };

export function startAccountMaintenance(intervalMs = 60 * 60_000) {
  if (g.__ufaPurge) return;
  g.__ufaPurge = setInterval(() => void purgeDueAccounts().catch(() => {}), intervalMs);
  g.__ufaPurge.unref?.();
  setTimeout(() => void purgeDueAccounts().catch(() => {}), 60_000).unref?.();
}
