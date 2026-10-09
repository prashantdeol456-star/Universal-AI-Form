import "server-only";
import { isCafePermission } from "@ufa/shared";
import { generateToken, normalizeAccessCode, sha256 } from "@ufa/security";
import { audit } from "../audit";
import { asUser, db, type Actor } from "../db";
import { env } from "../env";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http";
import { sendMail } from "../mailer";
import { codeHash, displayNames, expireCafeSessions, toSessionViews, type CafeSessionView } from "./customer";

/**
 * The café's side (spec §42–49): a café owner registers the café and invites
 * operators; operators ask customers for access (or redeem a customer's code)
 * and then fill forms *for* that customer within exactly what was granted.
 * Database RLS (0002, 0010) is the real boundary; this module adds the workflow.
 */

const INVITE_TTL_HOURS = 72;
const PENDING_REQUEST_HOURS = 2;

export interface Cafe {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  status: string;
  myRole: "OWNER" | "OPERATOR";
}

/** The café this user works at (owners: the café they own). One café per account in this version. */
export async function myCafe(actor: Actor): Promise<Cafe | null> {
  return asUser(actor, async (tx) => {
    const [c] = await tx<(Omit<Cafe, "myRole"> & { cafe_role: string; owner_id: string })[]>`
      select c.id, c.name, c.phone, c.address, c.city, c.state, c.pincode, c.status, cu.cafe_role, c.owner_id
        from cafe_users cu join cafes c on c.id = cu.cafe_id
       where cu.user_id = ${actor.id} and cu.status = 'ACTIVE' and c.deleted_at is null
       order by (cu.cafe_role = 'OWNER') desc, c.created_at limit 1`;
    if (!c) return null;
    const { cafe_role, owner_id, ...rest } = c;
    return { ...rest, myRole: cafe_role === "OWNER" || owner_id === actor.id ? "OWNER" : "OPERATOR" };
  });
}

async function requireCafe(actor: Actor, role?: "OWNER"): Promise<Cafe> {
  const cafe = await myCafe(actor);
  if (!cafe) throw notFound("You are not part of a café yet");
  if (cafe.status !== "ACTIVE") throw forbidden("This café is not active");
  if (role === "OWNER" && cafe.myRole !== "OWNER") throw forbidden("Only the café owner can do this");
  return cafe;
}

export interface CafeInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}

export async function createCafe(actor: Actor, input: CafeInput, ip?: string): Promise<{ id: string }> {
  if (actor.role !== "CAFE_OWNER") throw forbidden("Only café owner accounts can register a café");
  if (await myCafe(actor)) throw conflict("You already have a café");
  return asUser(actor, async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      insert into cafes (name, owner_id, phone, address, city, state, pincode)
      values (${input.name.trim()}, ${actor.id}, ${input.phone || null}, ${input.address || null}, ${input.city || null}, ${input.state || null}, ${input.pincode || null})
      returning id`;
    await tx`insert into cafe_users (cafe_id, user_id, cafe_role) values (${c!.id}, ${actor.id}, 'OWNER')`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.created", targetType: "cafe", targetId: c!.id, subjectUserId: actor.id, cafeId: c!.id, ip }, tx);
    return { id: c!.id };
  });
}

export async function updateCafe(actor: Actor, input: CafeInput) {
  const cafe = await requireCafe(actor, "OWNER");
  await asUser(actor, (tx) => tx`
    update cafes set name = ${input.name.trim()}, phone = ${input.phone || null}, address = ${input.address || null},
                     city = ${input.city || null}, state = ${input.state || null}, pincode = ${input.pincode || null}
     where id = ${cafe.id}`);
  return { saved: true as const };
}

export interface Operator {
  cafeUserId: string;
  userId: string;
  name: string;
  email: string;
  role: "OWNER" | "OPERATOR";
  status: "ACTIVE" | "DISABLED";
  invitedPending: boolean;
}

export async function listOperators(actor: Actor): Promise<Operator[]> {
  const cafe = await requireCafe(actor, "OWNER");
  const rows = await asUser(actor, (tx) => tx<{ id: string; user_id: string; cafe_role: "OWNER" | "OPERATOR"; status: "ACTIVE" | "DISABLED" }[]>`
    select id, user_id, cafe_role, status from cafe_users where cafe_id = ${cafe.id} order by created_at`);
  if (!rows.length) return [];
  // Names/emails of the café's own staff only.
  const users = await db().system<{ id: string; full_name: string; email: string; has_password: boolean }[]>`
    select id, full_name, email, password_hash is not null as has_password from users where id in ${db().system(rows.map((r) => r.user_id))}`;
  return rows.map((r) => {
    const u = users.find((x) => x.id === r.user_id);
    return { cafeUserId: r.id, userId: r.user_id, name: u?.full_name ?? "—", email: u?.email ?? "—", role: r.cafe_role, status: r.status, invitedPending: !u?.has_password };
  });
}

/**
 * Creates a separate work account (role CAFE_OPERATOR) and e-mails a link to set
 * its password. Existing accounts are never converted: a customer's personal
 * account must not silently become a café account.
 */
export async function inviteOperator(actor: Actor, input: { fullName: string; email: string }, ip?: string) {
  const cafe = await requireCafe(actor, "OWNER");
  const email = input.email.trim().toLowerCase();
  const sql = db().system;
  const token = generateToken(32);
  const userId = await sql.begin(async (tx) => {
    const [existing] = await tx`select id from users where email = ${email}`;
    if (existing) throw conflict("This email already has an account. Operators need their own work email.");
    const [u] = await tx<{ id: string }[]>`
      insert into users (email, full_name, password_hash, role) values (${email}, ${input.fullName.trim()}, null, 'CAFE_OPERATOR') returning id`;
    await tx`insert into profiles (user_id) values (${u!.id})`;
    await tx`insert into auth_tokens (user_id, purpose, token_hash, expires_at)
             values (${u!.id}, 'PASSWORD_RESET', ${sha256(token)}, now() + make_interval(hours => ${INVITE_TTL_HOURS}))`;
    return u!.id;
  });
  // Membership under the owner's RLS (only the owner may add staff).
  await asUser(actor, async (tx) => {
    await tx`insert into cafe_users (cafe_id, user_id, cafe_role) values (${cafe.id}, ${userId}, 'OPERATOR')`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.operator_invited", targetType: "user", targetId: userId, subjectUserId: actor.id, cafeId: cafe.id, ip }, tx);
  });
  const link = `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendMail({
      to: email,
      subject: `You were added as an operator at ${cafe.name}`,
      text: `${cafe.name} added you as an operator on Universal AI Form Assistant.\n\nSet your password (link valid for ${INVITE_TTL_HOURS} hours):\n${link}\n\nYou will only ever see a customer's details after that customer approves it.`,
    });
  } catch (err) {
    console.error(`[cafe] invite email failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { invited: true as const };
}

/** Disable / re-enable an operator. Disabling cuts off every session they hold immediately (RLS checks membership). */
export async function setOperatorStatus(actor: Actor, cafeUserId: string, status: "ACTIVE" | "DISABLED", ip?: string) {
  const cafe = await requireCafe(actor, "OWNER");
  await asUser(actor, async (tx) => {
    const rows = await tx<{ user_id: string }[]>`
      update cafe_users set status = ${status} where id = ${cafeUserId} and cafe_id = ${cafe.id} and cafe_role = 'OPERATOR' returning user_id`;
    if (!rows.length) throw notFound("Operator not found");
    if (status === "DISABLED") {
      await tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
                where cafe_id = ${cafe.id} and operator_id = ${rows[0]!.user_id} and status in ('ACTIVE', 'PENDING')`;
    }
    await audit({ actorId: actor.id, actorRole: actor.role, action: `cafe.operator_${status === "ACTIVE" ? "enabled" : "disabled"}`, targetType: "user", targetId: rows[0]!.user_id, subjectUserId: actor.id, cafeId: cafe.id, ip }, tx);
  });
  return { saved: true as const };
}

/** Finds a customer by registered email or mobile. Answers the same way whether or not they exist. */
async function findCustomer(identifier: string): Promise<string | null> {
  const id = identifier.trim();
  const sql = db().system;
  if (id.includes("@")) {
    const [u] = await sql<{ id: string }[]>`
      select id from users where email = ${id.toLowerCase()} and role = 'CUSTOMER' and status = 'ACTIVE' and deleted_at is null`;
    return u?.id ?? null;
  }
  const digits = id.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) throw badRequest("Enter the customer's registered email or 10-digit mobile number");
  const rows = await sql<{ id: string }[]>`
    select u.id from users u
     where u.role = 'CUSTOMER' and u.status = 'ACTIVE' and u.deleted_at is null
       and (u.mobile = ${digits} or exists (
             select 1 from profile_fields f where f.user_id = u.id and f.field_key = 'contact.mobile'
                and f.deleted_at is null and not f.is_encrypted and f.value = ${digits}))
     limit 2`;
  // A number shared by two accounts is ambiguous: ask for the email instead.
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Operator asks a customer for access; the customer approves in their own dashboard. */
export async function requestAccess(actor: Actor, input: { identifier: string; permissions: string[]; purpose?: string | null }, ip?: string) {
  const cafe = await requireCafe(actor);
  const permissions = [...new Set(input.permissions)].filter(isCafePermission);
  if (!permissions.length) throw badRequest("Choose at least one category");
  const customerId = await findCustomer(input.identifier);
  if (customerId && customerId !== actor.id) {
    const sessionId = await asUser(actor, async (tx) => {
      const [s] = await tx<{ id: string }[]>`
        insert into cafe_sessions (cafe_id, customer_id, operator_id, purpose, expires_at)
        values (${cafe.id}, ${customerId}, ${actor.id}, ${input.purpose?.trim().slice(0, 200) || null}, now() + make_interval(hours => ${PENDING_REQUEST_HOURS}))
        returning id`;
      for (const p of permissions) await tx`insert into cafe_permissions (cafe_session_id, permission) values (${s!.id}, ${p})`;
      await tx`insert into cafe_customers (cafe_id, customer_id, created_by) values (${cafe.id}, ${customerId}, ${actor.id}) on conflict do nothing`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.access_requested", targetType: "cafe_session", targetId: s!.id, subjectUserId: customerId, cafeId: cafe.id, ip, metadata: { permissions } }, tx);
      return s!.id;
    });
    await db().system`
      insert into notifications (user_id, type, title, body, link)
      values (${customerId}, 'cafe_request', ${`${cafe.name} is asking for access`},
              ${`They want to fill a form for you${input.purpose ? ` (${input.purpose.slice(0, 100)})` : ""}. Approve only if you are at this café now.`},
              ${`/dashboard/cafe-access#${sessionId}`})`;
  }
  // Same answer either way, so the form cannot be used to discover who has an account.
  return { sent: true as const };
}

/** Operator redeems a customer's one-time code → an active session with exactly what the customer chose. */
export async function redeemCode(actor: Actor, rawCode: string, ip?: string): Promise<{ sessionId: string; customerName: string; expiresAt: string }> {
  const cafe = await requireCafe(actor);
  const code = normalizeAccessCode(rawCode);
  const invalid = new HttpError(400, "invalid_code", "This code is not valid or has expired. Ask the customer for a new one.");
  if (!code) throw invalid;
  const sql = db().system;
  const result = await sql.begin(async (tx) => {
    const [c] = await tx<{ id: string; customer_id: string; permissions: string[]; duration_minutes: number; purpose: string | null }[]>`
      select id, customer_id, permissions, duration_minutes, purpose from cafe_access_codes
       where code_hash = ${codeHash(code)} and used_at is null and cancelled_at is null and expires_at > now()
       for update`;
    if (!c || c.customer_id === actor.id) throw invalid;
    // Re-check membership with the system pool (the redeeming path bypasses RLS).
    const [m] = await tx`select 1 from cafe_users where cafe_id = ${cafe.id} and user_id = ${actor.id} and status = 'ACTIVE'`;
    if (!m) throw forbidden();
    const [s] = await tx<{ id: string; expires_at: Date }[]>`
      insert into cafe_sessions (cafe_id, customer_id, operator_id, purpose, status, approved_at, expires_at)
      values (${cafe.id}, ${c.customer_id}, ${actor.id}, ${c.purpose}, 'ACTIVE', now(), now() + make_interval(mins => ${c.duration_minutes}))
      returning id, expires_at`;
    for (const p of c.permissions.filter(isCafePermission)) await tx`insert into cafe_permissions (cafe_session_id, permission) values (${s!.id}, ${p})`;
    await tx`update cafe_access_codes set used_at = now(), used_session_id = ${s!.id} where id = ${c.id}`;
    await tx`insert into cafe_customers (cafe_id, customer_id, created_by) values (${cafe.id}, ${c.customer_id}, ${actor.id}) on conflict do nothing`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.code_redeemed", targetType: "cafe_session", targetId: s!.id, subjectUserId: c.customer_id, cafeId: cafe.id, ip, metadata: { permissions: c.permissions } }, tx);
    return { sessionId: s!.id, customerId: c.customer_id, expiresAt: s!.expires_at.toISOString() };
  });
  const names = await displayNames([result.customerId]);
  return { sessionId: result.sessionId, customerName: names.get(result.customerId) ?? "Customer", expiresAt: result.expiresAt };
}

export interface CafeSessionRow extends CafeSessionView {
  customerName: string;
}

/** Sessions of this café: owners see all, operators their own (RLS). */
export async function cafeSessions(actor: Actor, opts: { activeOnly?: boolean } = {}): Promise<CafeSessionRow[]> {
  const cafe = await requireCafe(actor);
  await expireCafeSessions();
  return asUser(actor, async (tx) => {
    const rows = await tx<Parameters<typeof toSessionViews>[1]>`
      select id, cafe_id, customer_id, operator_id, purpose, status, created_at, approved_at, expires_at, revoked_at
        from cafe_sessions
       where cafe_id = ${cafe.id}
         ${cafe.myRole === "OWNER" ? tx`` : tx`and operator_id = ${actor.id}`}
         ${opts.activeOnly ? tx`and status = 'ACTIVE' and expires_at > now()` : tx``}
       order by created_at desc limit 200`;
    const views = await toSessionViews(tx, rows);
    const names = await displayNames(rows.map((r) => r.customer_id));
    return views.map((v, i) => ({ ...v, customerName: names.get(rows[i]!.customer_id) ?? "Customer" }));
  });
}

/** The café ends a session early (it can never extend or activate one). */
export async function endSession(actor: Actor, id: string, ip?: string) {
  const cafe = await requireCafe(actor);
  await asUser(actor, async (tx) => {
    const rows = await tx<{ customer_id: string }[]>`
      update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
       where id = ${id} and cafe_id = ${cafe.id} and status in ('ACTIVE', 'PENDING') returning customer_id`;
    if (!rows.length) throw notFound("Session not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.session_ended", targetType: "cafe_session", targetId: id, subjectUserId: rows[0]!.customer_id, cafeId: cafe.id, ip }, tx);
  });
  return { ended: true as const };
}

export interface CafeReport {
  days: number;
  totals: { applications: number; submitted: number; customers: number; sessions: number };
  byOperator: Array<{ operatorId: string; name: string; applications: number; submitted: number; sessions: number }>;
  byDay: Array<{ day: string; applications: number }>;
  recent: Array<{ id: string; formName: string | null; domain: string; status: string; operatorName: string; customerName: string; createdAt: string }>;
}

/** Owner reports: counts and form metadata only — never customers' values. */
export async function cafeReport(actor: Actor, days = 30): Promise<CafeReport> {
  const cafe = await requireCafe(actor, "OWNER");
  const d = Math.min(Math.max(Math.round(days), 1), 365);
  return asUser(actor, async (tx) => {
    const apps = await tx<{ id: string; form_name: string | null; domain: string; status: string; operator_id: string | null; customer_id: string; created_at: Date }[]>`
      select id, form_name, domain, status, operator_id, customer_id, created_at from applications
       where cafe_id = ${cafe.id} and created_at >= now() - make_interval(days => ${d}) order by created_at desc`;
    const sessions = await tx<{ operator_id: string; customer_id: string }[]>`
      select operator_id, customer_id from cafe_sessions
       where cafe_id = ${cafe.id} and created_at >= now() - make_interval(days => ${d}) and approved_at is not null`;
    const names = await displayNames([...apps.map((a) => a.operator_id).filter((x): x is string => Boolean(x)), ...apps.map((a) => a.customer_id), ...sessions.map((s) => s.operator_id)]);
    const ops = new Set([...apps.map((a) => a.operator_id).filter((x): x is string => Boolean(x)), ...sessions.map((s) => s.operator_id)]);
    const byDay = new Map<string, number>();
    for (let i = d - 1; i >= 0; i--) byDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), 0);
    for (const a of apps) {
      const k = a.created_at.toISOString().slice(0, 10);
      if (byDay.has(k)) byDay.set(k, byDay.get(k)! + 1);
    }
    return {
      days: d,
      totals: {
        applications: apps.length,
        submitted: apps.filter((a) => a.status === "SUBMITTED").length,
        customers: new Set([...apps.map((a) => a.customer_id), ...sessions.map((s) => s.customer_id)]).size,
        sessions: sessions.length,
      },
      byOperator: [...ops].map((op) => ({
        operatorId: op,
        name: names.get(op) ?? "—",
        applications: apps.filter((a) => a.operator_id === op).length,
        submitted: apps.filter((a) => a.operator_id === op && a.status === "SUBMITTED").length,
        sessions: sessions.filter((s) => s.operator_id === op).length,
      })),
      byDay: [...byDay.entries()].map(([day, applications]) => ({ day, applications })),
      recent: apps.slice(0, 25).map((a) => ({
        id: a.id,
        formName: a.form_name,
        domain: a.domain,
        status: a.status,
        operatorName: (a.operator_id && names.get(a.operator_id)) || "—",
        customerName: names.get(a.customer_id) ?? "—",
        createdAt: a.created_at.toISOString(),
      })),
    };
  });
}

/** Owner closes the café for good: all sessions end, operators lose access, history stays with customers. */
export async function closeCafe(actor: Actor, ip?: string) {
  const cafe = await requireCafe(actor, "OWNER");
  await asUser(actor, async (tx) => {
    await tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${actor.id}
              where cafe_id = ${cafe.id} and status in ('ACTIVE', 'PENDING')`;
    await tx`update cafe_users set status = 'DISABLED' where cafe_id = ${cafe.id} and cafe_role = 'OPERATOR'`;
    await tx`update cafes set status = 'CLOSED', deleted_at = now() where id = ${cafe.id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "cafe.closed", targetType: "cafe", targetId: cafe.id, subjectUserId: actor.id, cafeId: cafe.id, ip }, tx);
  });
  return { closed: true as const };
}
