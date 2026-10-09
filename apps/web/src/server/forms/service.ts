import "server-only";
import { diffFormVersions } from "@ufa/ai";
import type { FormSnapshot } from "@ufa/form-engine";
import type { TransactionSql } from "@ufa/db";
import { db } from "../db";
import { badRequest } from "../http";

export interface RecordedForm {
  formSignatureId: string;
  seenBefore: boolean;
  firstSeenAt: string;
}

/**
 * Records a form's structure in the shared knowledge base (spec §24, §58).
 * Stored: domain, path, title, signatures and field count — no user values, no
 * query strings. Written with the system pool because form_signatures is shared
 * across users; the caller has already been authenticated.
 */
export async function recordFormSignature(snapshot: FormSnapshot): Promise<RecordedForm> {
  let host: string;
  try {
    host = new URL(snapshot.url).hostname;
  } catch {
    throw badRequest("Invalid page URL");
  }
  if (host !== snapshot.domain) throw badRequest("Domain does not match the page URL");
  if (snapshot.fields.length === 0) throw badRequest("No fields to record");

  const urlPattern = new URL(snapshot.url).pathname.slice(0, 500);
  const allSignatures = [...new Set(snapshot.fields.map((f) => f.signature))].sort();
  const [row] = await db().system<{ id: string; first_seen_at: Date; inserted: boolean }[]>`
    insert into form_signatures (domain, url_pattern, form_title, field_signature_hash, structure_hash, field_count, field_signatures)
    values (${snapshot.domain}, ${urlPattern}, ${snapshot.formTitle ?? snapshot.pageTitle ?? null}, ${snapshot.formSignature},
            ${snapshot.structureHash}, ${snapshot.fields.filter((f) => f.visible).length}, ${allSignatures})
    on conflict (domain, field_signature_hash) do update
       set last_seen_at = now(),
           structure_hash = excluded.structure_hash,
           field_count = excluded.field_count,
           -- Hidden fields can differ between visits: keep every signature ever seen for this version.
           field_signatures = (select array(select distinct unnest(form_signatures.field_signatures || excluded.field_signatures) order by 1)),
           -- Shared record: one user's client must not be able to rename a known form.
           form_title = coalesce(form_signatures.form_title, excluded.form_title)
    returning id, first_seen_at, (xmax = 0) as inserted`;
  return { formSignatureId: row!.id, seenBefore: !row!.inserted, firstSeenAt: row!.first_seen_at.toISOString() };
}

export interface FormChangeView {
  /** Fields that did not exist on this page before the user's last application. */
  added: number;
  /** Fields the user filled last time that are no longer on the page. */
  removed: number;
  lastAppliedAt: string;
}

/**
 * "This form changed since you last applied" (spec §59). Only reported when the
 * current version of the page first appeared after that application, so fields
 * that show up dynamically (District after State) do not count as a change.
 */
export async function detectFormChange(
  tx: TransactionSql,
  userId: string,
  snapshot: FormSnapshot,
  formSignatureId: string,
): Promise<FormChangeView | null> {
  const urlPattern = new URL(snapshot.url).pathname.slice(0, 500);
  const [last] = await tx<{ id: string; created_at: Date }[]>`
    select id, created_at from applications
     where customer_id = ${userId} and website_url = ${snapshot.url} and status in ('CONFIRMED', 'SUBMITTED')
     order by created_at desc limit 1`;
  if (!last) return null;

  // Shared, structure-only table: read with the system pool.
  const sys = db().system;
  const [current] = await sys<{ first_seen_at: Date }[]>`select first_seen_at from form_signatures where id = ${formSignatureId}`;
  if (!current || current.first_seen_at <= last.created_at) return null;

  const versions = await sys<{ field_signatures: string[]; first_seen_at: Date }[]>`
    select field_signatures, first_seen_at from form_signatures where domain = ${snapshot.domain} and url_pattern = ${urlPattern}`;
  const knownBefore = versions.filter((v) => v.first_seen_at <= last.created_at).flatMap((v) => v.field_signatures);
  const seenSince = versions.filter((v) => v.first_seen_at > last.created_at).flatMap((v) => v.field_signatures);
  if (!knownBefore.length) return null;
  const applied = await tx<{ field_signature: string }[]>`
    select field_signature from application_fields where application_id = ${last.id} and field_signature is not null`;

  const diff = diffFormVersions(
    snapshot.fields.map((f) => f.signature),
    knownBefore,
    applied.map((a) => a.field_signature),
    seenSince,
  );
  if (!diff.added && !diff.removed) return null;
  return { ...diff, lastAppliedAt: last.created_at.toISOString() };
}
