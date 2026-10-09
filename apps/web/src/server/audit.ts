import "server-only";
import type { TransactionSql } from "@ufa/db";
import { redactObject } from "@ufa/security";
import { db } from "./db";

export interface AuditEvent {
  actorId: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  subjectUserId?: string | null;
  cafeId?: string | null;
  ip?: string;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes an audit event. Pass `tx` to make the event part of the same
 * transaction as the change it describes; otherwise the system pool is used
 * (e.g. failed logins, where there is no authenticated actor).
 * Metadata is redacted — never put raw sensitive values in audit logs.
 */
export async function audit(e: AuditEvent, tx?: TransactionSql) {
  const sql = tx ?? db().system;
  // sql.json: stored as a JSON object (a pre-stringified value would be saved as a JSON *string*).
  const meta = sql.json(JSON.parse(JSON.stringify(redactObject(e.metadata ?? {}))));
  await sql`
    insert into audit_logs (actor_id, actor_role, action, target_type, target_id, subject_user_id, cafe_id, ip_address, user_agent, metadata)
    values (${e.actorId}, ${e.actorRole ?? null}, ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null},
            ${e.subjectUserId ?? null}, ${e.cafeId ?? null}, ${e.ip ?? null}, ${e.userAgent?.slice(0, 300) ?? null}, ${meta})`;
}
