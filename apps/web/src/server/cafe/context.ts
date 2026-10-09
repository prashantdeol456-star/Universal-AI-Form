import "server-only";
import { isCafePermission, type CafePermission } from "@ufa/shared";
import { asUser, type Actor } from "../db";
import { HttpError } from "../http";
import { displayNames } from "./customer";

/**
 * "Filling for a customer" in the extension. Every café request names the
 * session; it is re-checked on every call, so a revoked or expired session stops
 * working on the very next request.
 */
export interface CafeContext {
  sessionId: string;
  cafeId: string;
  customerId: string;
  customerName: string;
  permissions: CafePermission[];
  expiresAt: string;
}

export const cafeSessionEnded = () =>
  new HttpError(403, "cafe_session_ended", "This customer's café session has ended or was revoked. Ask the customer for a new code.");

export async function resolveCafeContext(actor: Actor, sessionId: string): Promise<CafeContext> {
  const ctx = await asUser(actor, async (tx) => {
    const [s] = await tx<{ id: string; cafe_id: string; customer_id: string; expires_at: Date }[]>`
      select s.id, s.cafe_id, s.customer_id, s.expires_at
        from cafe_sessions s
        join cafe_users cu on cu.cafe_id = s.cafe_id and cu.user_id = s.operator_id and cu.status = 'ACTIVE'
       where s.id = ${sessionId} and s.operator_id = ${actor.id} and s.status = 'ACTIVE' and s.revoked_at is null and s.expires_at > now()`;
    if (!s) return null;
    const perms = await tx<{ permission: string }[]>`select permission from cafe_permissions where cafe_session_id = ${s.id}`;
    return { s, permissions: perms.map((p) => p.permission).filter(isCafePermission) };
  });
  if (!ctx) throw cafeSessionEnded();
  const names = await displayNames([ctx.s.customer_id]);
  return {
    sessionId: ctx.s.id,
    cafeId: ctx.s.cafe_id,
    customerId: ctx.s.customer_id,
    customerName: names.get(ctx.s.customer_id) ?? "Customer",
    permissions: ctx.permissions,
    expiresAt: ctx.s.expires_at.toISOString(),
  };
}
