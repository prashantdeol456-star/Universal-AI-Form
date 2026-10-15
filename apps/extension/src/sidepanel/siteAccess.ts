import { checkUrl, decideAction, type ActionDecision, type BrowserAction } from "@ufa/form-engine";
import { grantSitePermission, listSitePermissions, revokeSitePermission, type SitePermission } from "./api";
import { originPattern } from "./storage";

/**
 * Site access (AI browser Phase 2). The user allows one site at a time; the extension then
 * holds Chrome host access for that origin only, and the server keeps the grant (and checks
 * it again on every mapping, fill and document request). Submitting, Next/Continue,
 * payments and messages are never grantable.
 */
let cache: { at: number; sites: SitePermission[] } | null = null;

export async function siteGrants(force = false): Promise<SitePermission[]> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.sites;
  cache = { at: Date.now(), sites: await listSitePermissions() };
  return cache.sites;
}

export const forgetSiteCache = () => {
  cache = null;
};

export async function decide(action: BrowserAction, url: string | null, extra: { targetUrl?: string; reviewedByUser?: boolean } = {}): Promise<ActionDecision> {
  if (!url) return { allowed: false, fix: "invalid_url", reason: "Chrome has not shared this tab with the assistant. Click the extension icon in the toolbar while on the page." };
  if (!checkUrl(url).ok && action !== "open_url") return decideAction({ action, url, grants: [] });
  return decideAction({ action, url, grants: await siteGrants(), ...extra });
}

export function grantOf(sites: SitePermission[], url: string | null): SitePermission | null {
  if (!url) return null;
  const c = checkUrl(url);
  return c.ok ? sites.find((s) => s.origin === c.origin) ?? null : null;
}

/**
 * Must be called directly from a click: Chrome only shows its permission prompt for a user
 * gesture, so the host permission is requested first, before any network call.
 */
export async function authorizeSite(url: string, scopes: SitePermission["scopes"]): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = checkUrl(url);
  if (!c.ok) return { ok: false, error: c.reason };
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] }).catch(() => false);
  if (!granted) return { ok: false, error: "Chrome access to this site was not granted." };
  try {
    await grantSitePermission(url, scopes);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  forgetSiteCache();
  return { ok: true };
}

export async function removeSiteAccess(site: SitePermission): Promise<void> {
  await revokeSitePermission(site.id);
  await chrome.permissions.remove({ origins: [`${site.origin}/*`] }).catch(() => false);
  forgetSiteCache();
}
