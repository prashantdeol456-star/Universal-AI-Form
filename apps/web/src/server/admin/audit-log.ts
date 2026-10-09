import "server-only";
import { db, type Actor } from "../db";
import { assertAdmin } from "./guard";

/** Searchable audit log. Metadata is already redacted when written (server/audit.ts). */
export interface AuditRow {
  id: string;
  at: string;
  action: string;
  actorEmail: string | null;
  actorRole: string | null;
  subjectEmail: string | null;
  targetType: string | null;
  cafeName: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
}

/** Rows written before the 0012 fix hold metadata as a JSON string; normalise to an object. */
function asObject(m: unknown): Record<string, unknown> {
  if (typeof m === "string") {
    try {
      const parsed: unknown = JSON.parse(m);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return m && typeof m === "object" ? (m as Record<string, unknown>) : {};
}

export async function searchAudit(actor: Actor, f: { action?: string; user?: string; page?: number } = {}) {
  assertAdmin(actor, "admin:audit_view");
  const sql = db().system;
  const pageSize = 50;
  const page = Math.max(1, f.page ?? 1);
  const action = f.action?.trim() ? `${f.action.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const user = f.user?.trim() ? `%${f.user.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await sql<{ id: string; created_at: Date; action: string; actor_email: string | null; actor_role: string | null; subject_email: string | null; target_type: string | null; cafe_name: string | null; ip_address: string | null; metadata: Record<string, unknown> }[]>`
    select l.id, l.created_at, l.action, a.email as actor_email, l.actor_role, s.email as subject_email, l.target_type, c.name as cafe_name,
           l.ip_address, l.metadata
      from audit_logs l
      left join users a on a.id = l.actor_id
      left join users s on s.id = l.subject_user_id
      left join cafes c on c.id = l.cafe_id
     where true
       ${action ? sql`and l.action like ${action}` : sql``}
       ${user ? sql`and (lower(a.email) like ${user} or lower(s.email) like ${user})` : sql``}
     order by l.created_at desc
     limit ${pageSize + 1} offset ${(page - 1) * pageSize}`;
  return {
    page,
    hasMore: rows.length > pageSize,
    rows: rows.slice(0, pageSize).map((r): AuditRow => ({
      id: r.id, at: r.created_at.toISOString(), action: r.action, actorEmail: r.actor_email, actorRole: r.actor_role, subjectEmail: r.subject_email,
      targetType: r.target_type, cafeName: r.cafe_name, ip: r.ip_address, metadata: asObject(r.metadata),
    })),
  };
}
