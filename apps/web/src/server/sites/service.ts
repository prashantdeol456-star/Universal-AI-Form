import "server-only";
import { checkUrl, SCOPE_TEXT, SITE_SCOPES, type SiteGrant, type SiteScope } from "@ufa/form-engine";
import { audit } from "../audit";
import { asUser, type Actor } from "../db";
import { badRequest, HttpError, notFound } from "../http";

/**
 * Per-site authorisation (AI browser Phase 2). The extension checks it before touching a
 * page; the server checks it again before it maps a form, hands out values to fill or
 * releases a document file, so a modified or compromised client cannot skip it.
 */
export interface SitePermissionView {
  id: string;
  origin: string;
  scopes: SiteScope[];
  createdAt: string;
}

const siteNotAllowed = (host: string, scope: SiteScope) =>
  new HttpError(403, "site_not_allowed", `${host} is not allowed to ${SCOPE_TEXT[scope]}. Allow the site in the side panel first.`);

export async function listSitePermissions(actor: Actor): Promise<SitePermissionView[]> {
  const rows = await asUser(actor, (tx) => tx<{ id: string; origin: string; scopes: SiteScope[]; created_at: Date }[]>`
    select id, origin, scopes, created_at from site_permissions where user_id = ${actor.id} and revoked_at is null order by origin`);
  return rows.map((r) => ({ id: r.id, origin: r.origin, scopes: r.scopes, createdAt: r.created_at.toISOString() }));
}

/** Allows `scopes` on the origin of `url` (merged with what was already allowed). */
export async function grantSite(actor: Actor, url: string, scopes: SiteScope[], ip?: string): Promise<SitePermissionView> {
  const c = checkUrl(url);
  if (!c.ok) throw badRequest(c.reason);
  const wanted = [...new Set(scopes)].filter((s): s is SiteScope => (SITE_SCOPES as readonly string[]).includes(s));
  if (!wanted.length) throw badRequest("Choose at least one permission");
  return asUser(actor, async (tx) => {
    const [existing] = await tx<{ id: string; scopes: SiteScope[] }[]>`
      select id, scopes from site_permissions where user_id = ${actor.id} and origin = ${c.origin} and revoked_at is null for update`;
    const merged = [...new Set([...(existing?.scopes ?? []), ...wanted])].sort() as SiteScope[];
    const [row] = existing
      ? await tx<{ id: string; origin: string; scopes: SiteScope[]; created_at: Date }[]>`
          update site_permissions set scopes = ${merged} where id = ${existing.id} returning id, origin, scopes, created_at`
      : await tx<{ id: string; origin: string; scopes: SiteScope[]; created_at: Date }[]>`
          insert into site_permissions (user_id, origin, scopes) values (${actor.id}, ${c.origin}, ${merged}) returning id, origin, scopes, created_at`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "site.authorized", targetType: "site_permission", targetId: row!.id, subjectUserId: actor.id, ip, metadata: { origin: c.origin, scopes: merged } }, tx);
    return { id: row!.id, origin: row!.origin, scopes: row!.scopes, createdAt: row!.created_at.toISOString() };
  });
}

export async function revokeSite(actor: Actor, id: string, ip?: string) {
  await asUser(actor, async (tx) => {
    const [row] = await tx<{ origin: string }[]>`update site_permissions set revoked_at = now() where id = ${id} and user_id = ${actor.id} and revoked_at is null returning origin`;
    if (!row) throw notFound("Site permission not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "site.revoked", targetType: "site_permission", targetId: id, subjectUserId: actor.id, ip, metadata: { origin: row.origin } }, tx);
  });
}

async function grantsOf(actor: Actor): Promise<SiteGrant[]> {
  return asUser(actor, (tx) => tx<SiteGrant[]>`select origin, scopes from site_permissions where user_id = ${actor.id} and revoked_at is null`);
}

/** Throws 403 unless the user allowed `scope` on the page's origin. */
export async function assertSiteAllowed(actor: Actor, pageUrl: string, scope: SiteScope): Promise<void> {
  const c = checkUrl(pageUrl);
  if (!c.ok) throw badRequest(c.reason);
  const g = (await grantsOf(actor)).find((x) => x.origin === c.origin);
  if (!g || !g.scopes.includes(scope)) throw siteNotAllowed(c.host, scope);
}

/** Same check when only the host name is known (document attach reports the domain). */
export async function assertHostAllowed(actor: Actor, host: string, scope: SiteScope): Promise<void> {
  const h = host.toLowerCase();
  const ok = (await grantsOf(actor)).some((g) => {
    try {
      return new URL(g.origin).hostname === h && g.scopes.includes(scope);
    } catch {
      return false;
    }
  });
  if (!ok) throw siteNotAllowed(h, scope);
}
