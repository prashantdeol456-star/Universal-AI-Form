/**
 * Browser-action policy (AI browser Phase 2). Pure functions shared by the extension
 * (before it touches a page) and the server (before it hands out values or files).
 * Safety is enforced here in code; nothing a page or a model says can widen it.
 */

/** What a user can allow for one site. */
export const SITE_SCOPES = ["inspect", "fill", "attach_file", "insert_text"] as const;
export type SiteScope = (typeof SITE_SCOPES)[number];

/** Actions the assistant never performs in this phase, whatever was approved. */
export const NEVER_AUTOMATED = ["click_next", "submit", "send_message", "pay", "create_account", "solve_captcha", "enter_otp", "enter_password"] as const;
export type NeverAction = (typeof NEVER_AUTOMATED)[number];

export type BrowserAction = SiteScope | "open_url" | NeverAction;

export interface SiteGrant {
  origin: string;
  scopes: readonly string[];
}

export type UrlCheck = { ok: true; origin: string; host: string } | { ok: false; reason: string };

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.(localhost|test))$/i;

/**
 * Only https:// pages, plus http:// on local development hosts. Rejects javascript:,
 * data:, file:, blob:, chrome:, about:, URLs with credentials and malformed input.
 */
export function checkUrl(raw: string): UrlCheck {
  const text = (raw ?? "").trim();
  if (!text || text.length > 2048) return { ok: false, reason: "The address is empty or too long" };
  // Control characters and whitespace inside a URL are a classic way to hide a scheme.
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u001f\u007f\s]/.test(text)) return { ok: false, reason: "The address contains hidden or blank characters" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "This is not a valid web address" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `“${u.protocol}” links are not allowed` };
  if (u.username || u.password) return { ok: false, reason: "Addresses with a user name or password in them are not allowed" };
  if (u.protocol === "http:" && !LOCAL_HOSTS.test(u.hostname)) return { ok: false, reason: "Only secure (https) websites are supported" };
  if (!u.hostname || u.hostname.endsWith(".")) return { ok: false, reason: "This is not a valid web address" };
  return { ok: true, origin: u.origin, host: u.hostname.toLowerCase() };
}

export const originOf = (url: string): string | null => {
  const c = checkUrl(url);
  return c.ok ? c.origin : null;
};

/** Same scheme, host and port. Subdomains are different sites. */
export const sameOrigin = (a: string, b: string): boolean => {
  const x = originOf(a);
  return x !== null && x === originOf(b);
};

export function grantFor(grants: readonly SiteGrant[], url: string): SiteGrant | null {
  const origin = originOf(url);
  return origin ? grants.find((g) => g.origin === origin) ?? null : null;
}

export type ActionDecision =
  | { allowed: true }
  | { allowed: false; reason: string; fix: "authorize_site" | "never" | "invalid_url" | "review_url" | "other_site" };

/**
 * May the assistant do `action` on `url`? `targetUrl` is where an action would lead
 * (open_url). Opening a URL always needs the user's review in the panel first.
 */
export function decideAction(input: { action: BrowserAction; url: string; grants: readonly SiteGrant[]; targetUrl?: string; reviewedByUser?: boolean }): ActionDecision {
  if ((NEVER_AUTOMATED as readonly string[]).includes(input.action)) {
    return { allowed: false, fix: "never", reason: NEVER_REASON[input.action as NeverAction] };
  }
  const page = checkUrl(input.url);
  if (!page.ok) return { allowed: false, fix: "invalid_url", reason: page.reason };
  if (input.action === "open_url") {
    const target = checkUrl(input.targetUrl ?? "");
    if (!target.ok) return { allowed: false, fix: "invalid_url", reason: target.reason };
    if (!input.reviewedByUser) return { allowed: false, fix: "review_url", reason: `Check the address before it opens: ${target.host}` };
    return { allowed: true };
  }
  const grant = grantFor(input.grants, input.url);
  if (!grant || !grant.scopes.includes(input.action)) {
    return { allowed: false, fix: "authorize_site", reason: `${page.host} is not allowed to ${SCOPE_TEXT[input.action as SiteScope]} yet` };
  }
  if (input.targetUrl && !sameOrigin(input.url, input.targetUrl)) {
    return { allowed: false, fix: "other_site", reason: "This would act on a different website than the one you allowed" };
  }
  return { allowed: true };
}

export const SCOPE_TEXT: Record<SiteScope, string> = {
  inspect: "read this page's form",
  fill: "fill fields",
  attach_file: "attach your documents",
  insert_text: "insert drafted text",
};

const NEVER_REASON: Record<NeverAction, string> = {
  click_next: "Moving to the next page can save or send your data, so you click Next / Continue yourself.",
  submit: "Submitting is always done by you.",
  send_message: "Sending messages is always done by you.",
  pay: "Payments are always done by you.",
  create_account: "Creating accounts is done by you.",
  solve_captcha: "CAPTCHAs are there to check that a person is present; you fill them.",
  enter_otp: "One-time codes are entered by you.",
  enter_password: "Passwords are entered by you (or your password manager).",
};

/** Classifies a page button by its text: the assistant never clicks any of them in this phase. */
export function buttonRole(text: string): "submit" | "next" | "save" | "payment" | "other" {
  const t = text.trim().toLowerCase();
  if (/\b(pay|payment|purchase|buy|checkout|place order)\b|भुगतान/.test(t)) return "payment";
  if (/\b(submit|apply|send|finish|complete|register|sign up|confirm)\b|जमा करें|आवेदन करें/.test(t)) return "submit";
  if (/\b(save)\b|सहेजें/.test(t)) return "save";
  if (/\b(next|continue|proceed)\b|आगे|अगला/.test(t)) return "next";
  return "other";
}
