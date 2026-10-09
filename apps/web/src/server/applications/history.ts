import "server-only";
import { DOCUMENT_TYPE_LABELS, getFieldDef, maskValue, type DocumentType } from "@ufa/shared";
import { audit } from "../audit";
import { asUser, decryptValue, type Actor } from "../db";
import { badRequest, notFound } from "../http";

/**
 * Application history (spec §34–36, phase 8): search, details with the
 * confirmed snapshot (sensitive values masked until revealed, audited),
 * timeline, and links to the documents used for an application.
 */

export interface ApplicationListItem {
  id: string;
  formName: string | null;
  domain: string;
  websiteUrl: string;
  status: string;
  applicationNumber: string | null;
  fields: number;
  filled: number | null;
  documents: number;
  createdAt: string;
  confirmedAt: string | null;
  submittedAt: string | null;
}

export interface HistoryFilter {
  q?: string;
  status?: string;
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD, inclusive */
  to?: string;
  page?: number;
  pageSize?: number;
}

export const HISTORY_STATUSES = ["CONFIRMED", "SUBMITTED", "CANCELLED", "FAILED", "ARCHIVED", "IN_PROGRESS"] as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type ListRow = {
  id: string;
  form_name: string | null;
  domain: string;
  website_url: string;
  status: string;
  application_number: string | null;
  created_at: Date;
  confirmed_at: Date | null;
  submitted_at: Date | null;
  fields: number;
  filled: number | null;
  documents: number;
};

const toItem = (r: ListRow): ApplicationListItem => ({
  id: r.id,
  formName: r.form_name,
  domain: r.domain,
  websiteUrl: r.website_url,
  status: r.status,
  applicationNumber: r.application_number,
  fields: r.fields,
  filled: r.filled,
  documents: r.documents,
  createdAt: r.created_at.toISOString(),
  confirmedAt: r.confirmed_at?.toISOString() ?? null,
  submittedAt: r.submitted_at?.toISOString() ?? null,
});

/** Searchable, paginated history (form name, website, URL, application number). */
export async function searchApplications(
  actor: Actor,
  f: HistoryFilter = {},
): Promise<{ items: ApplicationListItem[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const q = f.q?.trim().slice(0, 100) || null;
  const like = q ? `%${escapeLike(q)}%` : null;
  const status = f.status && (HISTORY_STATUSES as readonly string[]).includes(f.status) ? f.status : null;
  const from = f.from && ISO_DAY.test(f.from) ? f.from : null;
  const to = f.to && ISO_DAY.test(f.to) ? f.to : null;

  return asUser(actor, async (tx) => {
    const where = tx`
      a.customer_id = ${actor.id}
      ${like ? tx`and (a.form_name ilike ${like} or a.domain ilike ${like} or a.website_url ilike ${like} or a.application_number ilike ${like})` : tx``}
      ${status ? tx`and a.status = ${status}` : tx``}
      ${from ? tx`and a.created_at >= ${from}::date` : tx``}
      ${to ? tx`and a.created_at < (${to}::date + 1)` : tx``}`;
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n from applications a where ${where}`;
    const rows = await tx<ListRow[]>`
      select a.id, a.form_name, a.domain, a.website_url, a.status, a.application_number, a.created_at, a.confirmed_at, a.submitted_at,
             (select count(*)::int from application_fields f where f.application_id = a.id) as fields,
             (select (e.details->>'filled')::int from application_events e
               where e.application_id = a.id and e.event_type = 'FILLED' order by e.created_at desc limit 1) as filled,
             (select count(*)::int from application_documents d where d.application_id = a.id) as documents
        from applications a
       where ${where}
       order by a.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}`;
    return { total: count!.n, page, pageSize, items: rows.map(toItem) };
  });
}

/** Earlier applications for the same form (by form signature, else exact URL) — shown in the extension. */
export async function previousApplications(actor: Actor, formSignatureId: string | null, url: string, limit = 3) {
  return asUser(actor, async (tx) => {
    const rows = await tx<{ id: string; status: string; application_number: string | null; created_at: Date; submitted_at: Date | null }[]>`
      select id, status, application_number, created_at, submitted_at from applications
       where customer_id = ${actor.id}
         and (${formSignatureId}::uuid is not null and form_signature_id = ${formSignatureId}::uuid or website_url = ${url})
         and status in ('CONFIRMED', 'SUBMITTED')
       order by created_at desc limit ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      applicationNumber: r.application_number,
      createdAt: r.created_at.toISOString(),
      submittedAt: r.submitted_at?.toISOString() ?? null,
    }));
  });
}

/** Sensitive values stay masked until the owner explicitly reveals them (audited). */
function isSensitiveSnapshot(key: string | null, value: string): boolean {
  if (key) return (getFieldDef(key)?.sensitivity ?? "normal") !== "normal";
  // Typed by hand: long digit runs (Aadhaar, account numbers…) are treated as sensitive.
  return /\d{8,}/.test(value.replace(/[\s-]/g, ""));
}

export interface ApplicationFieldView {
  id: string;
  label: string;
  name: string | null;
  type: string | null;
  value: string | null;
  masked: boolean;
  profileFieldKey: string | null;
  profileFieldLabel: string | null;
  source: string | null;
  confidence: number | null;
  aiProvider: string | null;
  verified: boolean;
}

export interface ApplicationDetail extends ApplicationListItem {
  fieldsList: ApplicationFieldView[];
  events: Array<{ type: string; at: string; details: Record<string, unknown> }>;
  linkedDocuments: Array<{ id: string; title: string; typeLabel: string; label: string | null }>;
  availableDocuments: Array<{ id: string; title: string; typeLabel: string }>;
  fillOutcome: { filled: number; skipped: number; failed: number } | null;
}

const docTitle = (d: { title: string | null; original_filename: string }) => d.title || d.original_filename;
const docTypeLabel = (t: string) => DOCUMENT_TYPE_LABELS[t as DocumentType]?.en ?? t;

export async function getApplication(actor: Actor, id: string): Promise<ApplicationDetail> {
  return asUser(actor, async (tx) => {
    const [a] = await tx<ListRow[]>`
      select a.id, a.form_name, a.domain, a.website_url, a.status, a.application_number, a.created_at, a.confirmed_at, a.submitted_at,
             0 as fields, null::int as filled, 0 as documents
        from applications a where a.id = ${id} and a.customer_id = ${actor.id}`;
    if (!a) throw notFound("Application not found");
    const fields = await tx<{
      id: string; website_field_label: string; website_field_name: string | null; field_type: string | null; field_value: string | null;
      is_encrypted: boolean; profile_field_key: string | null; source: string | null; confidence: string | null; ai_provider: string | null; verified: boolean;
    }[]>`
      select id, website_field_label, website_field_name, field_type, field_value, is_encrypted, profile_field_key, source, confidence, ai_provider, verified
        from application_fields where application_id = ${id} order by position nulls last, created_at, id`;
    const events = await tx<{ event_type: string; created_at: Date; details: Record<string, unknown> }[]>`
      select event_type, created_at, details from application_events where application_id = ${id} order by created_at`;
    const linked = await tx<{ id: string; title: string | null; original_filename: string; document_type: string; website_field_label: string | null }[]>`
      select d.id, d.title, d.original_filename, d.document_type, ad.website_field_label
        from application_documents ad join documents d on d.id = ad.document_id
       where ad.application_id = ${id} order by ad.created_at`;
    const docs = await tx<{ id: string; title: string | null; original_filename: string; document_type: string }[]>`
      select id, title, original_filename, document_type from documents
       where user_id = ${actor.id} and deleted_at is null order by created_at desc limit 200`;

    const lastFill = [...events].reverse().find((e) => e.event_type === "FILLED");
    const linkedIds = new Set(linked.map((l) => l.id));
    return {
      ...toItem(a),
      fields: fields.length,
      filled: lastFill ? Number(lastFill.details.filled ?? 0) : null,
      documents: linked.length,
      fieldsList: fields.map((f) => {
        const plain = f.field_value === null ? null : f.is_encrypted ? decryptValue(f.field_value) : f.field_value;
        const masked = plain !== null && isSensitiveSnapshot(f.profile_field_key, plain);
        return {
          id: f.id,
          label: f.website_field_label,
          name: f.website_field_name,
          type: f.field_type,
          value: plain === null ? null : masked ? maskValue(plain) : plain,
          masked,
          profileFieldKey: f.profile_field_key,
          profileFieldLabel: f.profile_field_key ? (getFieldDef(f.profile_field_key)?.label.en ?? f.profile_field_key) : null,
          source: f.source,
          confidence: f.confidence === null ? null : Number(f.confidence),
          aiProvider: f.ai_provider,
          verified: f.verified,
        };
      }),
      events: events.map((e) => ({ type: e.event_type, at: e.created_at.toISOString(), details: e.details })),
      linkedDocuments: linked.map((d) => ({ id: d.id, title: docTitle(d), typeLabel: docTypeLabel(d.document_type), label: d.website_field_label })),
      availableDocuments: docs.filter((d) => !linkedIds.has(d.id)).map((d) => ({ id: d.id, title: docTitle(d), typeLabel: docTypeLabel(d.document_type) })),
      fillOutcome: lastFill
        ? { filled: Number(lastFill.details.filled ?? 0), skipped: Number(lastFill.details.skipped ?? 0), failed: Number(lastFill.details.failed ?? 0) }
        : null,
    };
  });
}

/** Full values of one application's snapshot for its owner (audited, like revealing a profile value). */
export async function revealApplicationValues(actor: Actor, id: string, ip?: string): Promise<Array<{ id: string; value: string | null }>> {
  return asUser(actor, async (tx) => {
    const [a] = await tx<{ id: string }[]>`select id from applications where id = ${id} and customer_id = ${actor.id}`;
    if (!a) throw notFound("Application not found");
    const rows = await tx<{ id: string; field_value: string | null; is_encrypted: boolean }[]>`
      select id, field_value, is_encrypted from application_fields where application_id = ${id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "application.values_revealed", targetType: "application", targetId: id, subjectUserId: actor.id, ip }, tx);
    return rows.map((r) => ({ id: r.id, value: r.field_value === null ? null : r.is_encrypted ? decryptValue(r.field_value) : r.field_value }));
  });
}

/** Links documents used for an application (e.g. the photo uploaded on the portal). Own documents only (RLS + 0007 policy). */
export async function linkDocuments(actor: Actor, id: string, links: Array<{ documentId: string; label?: string | null }>) {
  await asUser(actor, async (tx) => {
    const [a] = await tx<{ id: string }[]>`select id from applications where id = ${id} and customer_id = ${actor.id}`;
    if (!a) throw notFound("Application not found");
    const ids = [...new Set(links.map((l) => l.documentId))];
    const owned = await tx<{ id: string }[]>`select id from documents where id in ${tx(ids)} and user_id = ${actor.id} and deleted_at is null`;
    if (owned.length !== ids.length) throw badRequest("Unknown document");
    for (const l of links) {
      await tx`
        insert into application_documents (application_id, document_id, website_field_label)
        values (${id}, ${l.documentId}, ${l.label?.trim().slice(0, 200) || null})
        on conflict do nothing`;
    }
    await tx`insert into application_events (application_id, actor_id, event_type, details)
             values (${id}, ${actor.id}, 'DOCUMENTS_LINKED', ${tx.json({ count: links.length })})`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "application.documents_linked", targetType: "application", targetId: id, subjectUserId: actor.id, metadata: { count: links.length } }, tx);
  });
  return { saved: true as const };
}

export async function unlinkDocument(actor: Actor, id: string, documentId: string) {
  await asUser(actor, async (tx) => {
    const removed = await tx`delete from application_documents where application_id = ${id} and document_id = ${documentId} returning 1`;
    if (!removed.length) throw notFound("Link not found");
    await tx`insert into application_events (application_id, actor_id, event_type, details)
             values (${id}, ${actor.id}, 'DOCUMENT_UNLINKED', ${tx.json({})})`;
  });
  return { removed: true as const };
}

/** Quotes a CSV cell and neutralises spreadsheet formulas (CSV injection). */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** History as CSV: metadata only — never field values. */
export async function exportHistoryCsv(actor: Actor, f: HistoryFilter): Promise<string> {
  const { items } = await searchApplications(actor, { ...f, page: 1, pageSize: 200 });
  const head = ["Form", "Website", "URL", "Status", "Application number", "Fields confirmed", "Fields filled", "Documents", "Confirmed at", "Submitted at"];
  const lines = items.map((a) =>
    [a.formName, a.domain, a.websiteUrl, a.status, a.applicationNumber, a.fields, a.filled, a.documents, a.confirmedAt, a.submittedAt].map(csvCell).join(","),
  );
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
