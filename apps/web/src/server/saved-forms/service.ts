import "server-only";
import { safePageUrl } from "@ufa/form-engine";
import { audit } from "../audit";
import { asUser, type Actor } from "../db";
import { badRequest, notFound } from "../http";

/**
 * Saved forms (phase 8): the user's bookmarks of application portals they use,
 * with how often and when they last applied there. Owner-only (RLS).
 */

export interface SavedForm {
  id: string;
  name: string;
  url: string;
  domain: string;
  notes: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  applications: number;
  lastApplication: { id: string; status: string; at: string } | null;
}

/** Only http(s), and only origin + path: query strings can carry session tokens. */
export function normaliseFormUrl(raw: string): { url: string; domain: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest("Enter a valid web address (https://…)");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest("Only http(s) addresses can be saved");
  return { url: safePageUrl(u.href), domain: u.hostname };
}

export async function listSavedForms(actor: Actor): Promise<SavedForm[]> {
  return asUser(actor, async (tx) => {
    const rows = await tx<{
      id: string; name: string; url: string; domain: string; notes: string | null; created_at: Date; last_used_at: Date | null;
      apps: number; last_id: string | null; last_status: string | null; last_at: Date | null;
    }[]>`
      select s.id, s.name, s.url, s.domain, s.notes, s.created_at, s.last_used_at,
             (select count(*)::int from applications a
               where a.customer_id = s.user_id and (a.website_url = s.url or (s.form_signature_id is not null and a.form_signature_id = s.form_signature_id))) as apps,
             l.id as last_id, l.status as last_status, l.created_at as last_at
        from saved_forms s
        left join lateral (
          select a.id, a.status, a.created_at from applications a
           where a.customer_id = s.user_id and (a.website_url = s.url or (s.form_signature_id is not null and a.form_signature_id = s.form_signature_id))
           order by a.created_at desc limit 1
        ) l on true
       where s.user_id = ${actor.id} and s.deleted_at is null
       order by coalesce(s.last_used_at, s.created_at) desc`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      domain: r.domain,
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      applications: r.apps,
      lastApplication: r.last_id && r.last_status && r.last_at ? { id: r.last_id, status: r.last_status, at: r.last_at.toISOString() } : null,
    }));
  });
}

export interface SaveFormInput {
  name: string;
  url: string;
  notes?: string | null;
  formSignatureId?: string | null;
}

/** Creates a bookmark, or returns the existing one for the same URL (idempotent for the extension's "Save" button). */
export async function saveForm(actor: Actor, input: SaveFormInput): Promise<{ id: string; created: boolean }> {
  const { url, domain } = normaliseFormUrl(input.url);
  const name = input.name.trim().slice(0, 200) || domain;
  return asUser(actor, async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      select id from saved_forms where user_id = ${actor.id} and url = ${url} and deleted_at is null`;
    if (existing) return { id: existing.id, created: false };
    const [row] = await tx<{ id: string }[]>`
      insert into saved_forms (user_id, name, url, domain, form_signature_id, notes)
      values (${actor.id}, ${name}, ${url}, ${domain}, ${input.formSignatureId ?? null}, ${input.notes?.trim().slice(0, 1000) || null})
      returning id`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "saved_form.created", targetType: "saved_form", targetId: row!.id, subjectUserId: actor.id, metadata: { domain } }, tx);
    return { id: row!.id, created: true };
  });
}

export async function updateSavedForm(actor: Actor, id: string, u: { name?: string; notes?: string | null }) {
  return asUser(actor, async (tx) => {
    const name = u.name === undefined ? undefined : u.name.trim().slice(0, 200);
    if (name === "") throw badRequest("Name cannot be empty");
    const rows = await tx`
      update saved_forms
         set name = coalesce(${name ?? null}, name),
             notes = ${u.notes === undefined ? tx`notes` : tx`${u.notes?.trim().slice(0, 1000) || null}`}
       where id = ${id} and user_id = ${actor.id} and deleted_at is null
      returning id`;
    if (!rows.length) throw notFound("Saved form not found");
    return { saved: true as const };
  });
}

export async function deleteSavedForm(actor: Actor, id: string) {
  return asUser(actor, async (tx) => {
    const rows = await tx`update saved_forms set deleted_at = now() where id = ${id} and user_id = ${actor.id} and deleted_at is null returning id`;
    if (!rows.length) throw notFound("Saved form not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "saved_form.deleted", targetType: "saved_form", targetId: id, subjectUserId: actor.id }, tx);
    return { removed: true as const };
  });
}

/** For the extension: is this page saved already? */
export async function findSavedForm(actor: Actor, rawUrl: string): Promise<{ id: string; name: string } | null> {
  const { url } = normaliseFormUrl(rawUrl);
  return asUser(actor, async (tx) => {
    const [row] = await tx<{ id: string; name: string }[]>`
      select id, name from saved_forms where user_id = ${actor.id} and url = ${url} and deleted_at is null`;
    return row ?? null;
  });
}
