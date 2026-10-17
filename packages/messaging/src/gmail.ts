import { createHash, randomBytes } from "node:crypto";
import { decodeBase64Url, encodeBase64Url, htmlToText, MAIL_LIMITS, parseAddressList, splitQuoted, tidy } from "./mime";

/**
 * Gmail through Google's OAuth 2.0 and the Gmail REST API (AI browser Phase 5).
 *
 * Scopes (least privilege; there is no Google scope that allows drafts without sending):
 *  - gmail.readonly — search and read messages (required);
 *  - gmail.compose — create drafts (optional, asked only when the user wants drafts created
 *    in Gmail). This scope technically also allows sending; this code has no send call at all
 *    (no messages.send, no drafts.send) and a source test enforces that.
 * Tokens are exchanged and used on the server only.
 */
export const GMAIL_SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  compose: "https://www.googleapis.com/auth/gmail.compose",
} as const;
export type GmailAccess = "read" | "read_draft";

export const scopesFor = (access: GmailAccess): string[] => (access === "read" ? [GMAIL_SCOPES.readonly] : [GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose]);

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  gmailBase: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  gmailBase: "https://gmail.googleapis.com/gmail/v1/users/me",
};

export type HttpLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class GmailError extends Error {
  constructor(
    public readonly code: "not_authorized" | "token_revoked" | "insufficient_scope" | "not_found" | "rate_limited" | "provider_error" | "invalid_response" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

// --- OAuth ---------------------------------------------------------------------------

/** PKCE (RFC 7636) verifier and S256 challenge, plus an unguessable state value. */
export function newAuthRequest(): { state: string; verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { state: randomBytes(32).toString("base64url"), verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(ep: GoogleEndpoints, p: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string; loginHint?: string | null }): string {
  const u = new URL(ep.authUrl);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", p.scopes.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // A refresh token is needed to read on the user's request later; consent makes Google return it.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

async function call(http: HttpLike, url: string, init: Parameters<HttpLike>[1] = {}): Promise<{ status: number; body: unknown }> {
  let res;
  try {
    res = await http(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const timeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    throw new GmailError(timeout ? "timeout" : "provider_error", timeout ? "Google did not answer in time" : "Google could not be reached");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function tokenSet(body: unknown, previousRefresh: string | null): TokenSet {
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof b?.access_token !== "string" || typeof b.expires_in !== "number") throw new GmailError("invalid_response", "Google returned an unexpected token response");
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : previousRefresh,
    expiresAt: Date.now() + Math.max(0, b.expires_in - 60) * 1000,
    scopes: typeof b.scope === "string" ? b.scope.split(" ").filter(Boolean) : [],
  };
}

export async function exchangeCode(http: HttpLike, ep: GoogleEndpoints, p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string }): Promise<TokenSet> {
  const r = await call(http, ep.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code_verifier: p.verifier }).toString(),
  });
  if (r.status !== 200) throw new GmailError("not_authorized", "Google did not accept the authorisation. Try connecting again.");
  return tokenSet(r.body, null);
}

export async function refreshAccess(http: HttpLike, ep: GoogleEndpoints, p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet> {
  const r = await call(http, ep.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret }).toString(),
  });
  if (r.status === 400 || r.status === 401) throw new GmailError("token_revoked", "Gmail access was revoked or expired. Connect Gmail again.");
  if (r.status !== 200) throw new GmailError("provider_error", `Google token refresh failed (HTTP ${r.status})`);
  return tokenSet(r.body, p.refreshToken);
}

/** Revokes the grant at Google (best effort: an already-revoked token is fine). */
export async function revokeToken(http: HttpLike, ep: GoogleEndpoints, token: string): Promise<boolean> {
  const r = await call(http, ep.revokeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
  return r.status === 200 || r.status === 400;
}

// --- Gmail API ----------------------------------------------------------------------------

async function api(http: HttpLike, ep: GoogleEndpoints, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const r = await call(http, `${ep.gmailBase}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) throw new GmailError("not_authorized", "Gmail access expired");
  if (r.status === 403) throw new GmailError("insufficient_scope", "Gmail did not allow this action with the access you granted");
  if (r.status === 404) throw new GmailError("not_found", "Not found in your mailbox");
  if (r.status === 429) throw new GmailError("rate_limited", "Gmail asked us to slow down. Try again in a minute.");
  if (r.status < 200 || r.status >= 300) throw new GmailError("provider_error", `Gmail answered with HTTP ${r.status}`);
  return r.body;
}

export async function getProfile(http: HttpLike, ep: GoogleEndpoints, token: string): Promise<{ email: string }> {
  const b = (await api(http, ep, token, "/profile")) as { emailAddress?: unknown };
  if (typeof b?.emailAddress !== "string") throw new GmailError("invalid_response", "Gmail returned no account address");
  return { email: b.emailAddress.toLowerCase() };
}

/** Structured search turned into a Gmail query; only known operators, quoted values. */
export interface MailSearch {
  text?: string;
  from?: string;
  subject?: string;
  after?: string;
  before?: string;
  unread?: boolean;
}

export function buildQuery(s: MailSearch): string {
  const q = (v: string) => `"${v.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)}"`;
  const date = (v: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new GmailError("invalid_response", "Dates must be YYYY-MM-DD");
    return v.replace(/-/g, "/");
  };
  const parts: string[] = [];
  if (s.from?.trim()) parts.push(`from:${q(s.from)}`);
  if (s.subject?.trim()) parts.push(`subject:${q(s.subject)}`);
  if (s.after) parts.push(`after:${date(s.after)}`);
  if (s.before) parts.push(`before:${date(s.before)}`);
  if (s.unread) parts.push("is:unread");
  if (s.text?.trim()) parts.push(q(s.text));
  // Never search spam or trash.
  parts.push("-in:spam", "-in:trash");
  return parts.join(" ");
}

export async function searchThreads(http: HttpLike, ep: GoogleEndpoints, token: string, query: string, pageToken: string | null, pageSize: number = MAIL_LIMITS.pageSize): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(pageSize, 1), MAIL_LIMITS.pageSize)) });
  if (pageToken) params.set("pageToken", pageToken);
  const b = (await api(http, ep, token, `/threads?${params}`)) as { threads?: Array<{ id?: unknown }>; nextPageToken?: unknown };
  const ids = (b?.threads ?? []).map((t) => t.id).filter((x): x is string => typeof x === "string" && /^[0-9a-f]{6,32}$/i.test(x));
  return { ids, nextPageToken: typeof b?.nextPageToken === "string" ? b.nextPageToken : null };
}

interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GPart;
}

export interface MailMessage {
  id: string;
  from: { name: string | null; email: string } | null;
  to: Array<{ name: string | null; email: string }>;
  cc: Array<{ name: string | null; email: string }>;
  replyTo: Array<{ name: string | null; email: string }>;
  subject: string | null;
  date: string | null;
  messageIdHeader: string | null;
  references: string | null;
  unread: boolean;
  /** New text of this message (quoted history removed), bounded. Untrusted. */
  body: string;
  hadQuotedText: boolean;
  /** Attachment names and sizes only; contents are never downloaded. */
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
  truncated: boolean;
}

const header = (p: GPart | undefined, name: string) => p?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

function collect(p: GPart | undefined, out: { plain: string[]; html: string[]; attachments: MailMessage["attachments"] }, depth = 0) {
  if (!p || depth > 10) return;
  if (p.filename && (p.body?.attachmentId || (p.body?.size ?? 0) > 0)) {
    out.attachments.push({ filename: p.filename.slice(0, 200), mimeType: (p.mimeType ?? "application/octet-stream").slice(0, 100), size: p.body?.size ?? 0 });
    return;
  }
  if (p.mimeType === "text/plain" && p.body?.data) out.plain.push(decodeBase64Url(p.body.data));
  else if (p.mimeType === "text/html" && p.body?.data) out.html.push(decodeBase64Url(p.body.data));
  for (const c of p.parts ?? []) collect(c, out, depth + 1);
}

export function parseMessage(m: GMessage): MailMessage | null {
  if (typeof m.id !== "string") return null;
  const parts = { plain: [] as string[], html: [] as string[], attachments: [] as MailMessage["attachments"] };
  collect(m.payload, parts);
  const raw = parts.plain.length ? tidy(parts.plain.join("\n")) : htmlToText(parts.html.join("\n"));
  const { fresh, quoted } = splitQuoted(raw);
  const from = parseAddressList(header(m.payload, "From"))[0] ?? null;
  const ms = Number(m.internalDate);
  return {
    id: m.id,
    from,
    to: parseAddressList(header(m.payload, "To")),
    cc: parseAddressList(header(m.payload, "Cc")),
    replyTo: parseAddressList(header(m.payload, "Reply-To")),
    subject: header(m.payload, "Subject")?.slice(0, MAIL_LIMITS.subjectChars) ?? null,
    date: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
    messageIdHeader: header(m.payload, "Message-ID") ?? header(m.payload, "Message-Id"),
    references: header(m.payload, "References"),
    unread: (m.labelIds ?? []).includes("UNREAD"),
    body: (fresh || raw).slice(0, MAIL_LIMITS.bodyChars),
    hadQuotedText: Boolean(quoted),
    attachments: parts.attachments.slice(0, 20),
    truncated: (fresh || raw).length > MAIL_LIMITS.bodyChars,
  };
}

export interface MailThread {
  id: string;
  subject: string | null;
  messages: MailMessage[];
  /** Messages left out (older than the most recent MAIL_LIMITS.threadMessages). */
  omitted: number;
}

export async function getThread(http: HttpLike, ep: GoogleEndpoints, token: string, threadId: string, format: "full" | "metadata" = "full"): Promise<MailThread> {
  if (!/^[0-9a-f]{6,32}$/i.test(threadId)) throw new GmailError("not_found", "Not a Gmail thread id");
  const qs = format === "metadata" ? "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Reply-To" : "?format=full";
  const b = (await api(http, ep, token, `/threads/${threadId}${qs}`)) as { id?: string; messages?: GMessage[] };
  const all = (b?.messages ?? []).map(parseMessage).filter((x): x is MailMessage => x !== null);
  const kept = all.slice(-MAIL_LIMITS.threadMessages);
  return { id: threadId, subject: kept[0]?.subject ?? null, messages: kept, omitted: all.length - kept.length };
}

/** Creates a draft in the user's Gmail (never sends). */
export async function createDraft(http: HttpLike, ep: GoogleEndpoints, token: string, raw: string, threadId: string | null): Promise<{ draftId: string; messageId: string | null }> {
  const b = (await api(http, ep, token, "/drafts", { method: "POST", body: { message: { raw: encodeBase64Url(raw), ...(threadId ? { threadId } : {}) } } })) as { id?: unknown; message?: { id?: unknown } };
  if (typeof b?.id !== "string") throw new GmailError("invalid_response", "Gmail did not return a draft id");
  return { draftId: b.id, messageId: typeof b.message?.id === "string" ? b.message.id : null };
}

/** Whether a draft still exists (used to avoid creating a duplicate on retry). */
export async function draftExists(http: HttpLike, ep: GoogleEndpoints, token: string, draftId: string): Promise<boolean> {
  try {
    await api(http, ep, token, `/drafts/${encodeURIComponent(draftId)}?format=minimal`);
    return true;
  } catch (err) {
    if (err instanceof GmailError && err.code === "not_found") return false;
    throw err;
  }
}

/** The thread needs a reply when its last message is not from the user (reliable only for threads we read). */
export function needsReply(thread: MailThread, myEmail: string): boolean {
  const last = thread.messages.at(-1);
  return Boolean(last?.from && last.from.email !== myEmail.toLowerCase());
}

/** Who a reply goes to: Reply-To, else From, of the last message not from the user. Never derived from message text. */
export function replyRecipients(thread: MailThread, myEmail: string): { to: string[]; replyToMessage: MailMessage | null } {
  const me = myEmail.toLowerCase();
  const last = [...thread.messages].reverse().find((m) => m.from && m.from.email !== me) ?? null;
  if (!last) return { to: [], replyToMessage: null };
  const to = (last.replyTo.length ? last.replyTo : last.from ? [last.from] : []).map((a) => a.email).filter((e) => e !== me);
  return { to: [...new Set(to)].slice(0, 10), replyToMessage: last };
}
