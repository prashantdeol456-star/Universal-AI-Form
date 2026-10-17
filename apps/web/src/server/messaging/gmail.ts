import "server-only";
import { createHash } from "node:crypto";
import {
  authorizationUrl,
  buildQuery,
  exchangeCode,
  getProfile,
  getThread,
  GmailError,
  GMAIL_SCOPES,
  GOOGLE_ENDPOINTS,
  needsReply,
  newAuthRequest,
  refreshAccess,
  revokeToken,
  scopesFor,
  searchThreads,
  type GmailAccess,
  type GoogleEndpoints,
  type HttpLike,
  type MailSearch,
  type MailThread,
} from "@ufa/messaging";
import { redact } from "@ufa/security";
import { audit } from "../audit";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { env } from "../env";
import { badRequest, HttpError, notFound } from "../http";

/**
 * Gmail connection (AI browser Phase 5). OAuth 2.0 authorisation-code flow with PKCE and a
 * single-use, 10-minute state bound to the signed-in user. Tokens are encrypted at rest,
 * used only on the server, and never returned to any client. Without client credentials
 * the integration reports "not configured" and nothing can be connected.
 */
let http: HttpLike = (url, init) => fetch(url, init);
export function setGmailHttp(h: HttpLike) {
  http = h;
}

export function gmailConfig(): { configured: boolean; clientId: string; clientSecret: string; redirectUri: string; endpoints: GoogleEndpoints } {
  const e = env();
  const redirectUri = e.GMAIL_OAUTH_REDIRECT_URI || `${e.APP_URL.replace(/\/$/, "")}/api/integrations/gmail/callback`;
  // Endpoint overrides exist for local testing against a mock; production always talks to Google.
  const dev = e.NODE_ENV !== "production";
  return {
    configured: Boolean(e.GMAIL_OAUTH_CLIENT_ID && e.GMAIL_OAUTH_CLIENT_SECRET),
    clientId: e.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: e.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri,
    endpoints: {
      authUrl: (dev && e.GOOGLE_OAUTH_AUTH_URL) || GOOGLE_ENDPOINTS.authUrl,
      tokenUrl: (dev && e.GOOGLE_OAUTH_TOKEN_URL) || GOOGLE_ENDPOINTS.tokenUrl,
      revokeUrl: (dev && e.GOOGLE_OAUTH_REVOKE_URL) || GOOGLE_ENDPOINTS.revokeUrl,
      gmailBase: (dev && e.GMAIL_API_BASE) || GOOGLE_ENDPOINTS.gmailBase,
    },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  status: "active" | "revoked" | "error" | null;
  account: string | null;
  canCreateDrafts: boolean;
  cloudAiAllowed: boolean;
  connectedAt: string | null;
  lastError: string | null;
}

interface ConnRow {
  id: string;
  account_email_encrypted: string;
  scopes: string[];
  refresh_token_encrypted: string | null;
  access_token_encrypted: string | null;
  access_expires_at: Date | null;
  cloud_ai_allowed: boolean;
  status: "active" | "revoked" | "error";
  last_error: string | null;
  connected_at: Date;
}

export async function gmailStatus(actor: Actor): Promise<GmailStatus> {
  const cfg = gmailConfig();
  const [c] = await asUser(actor, (tx) => tx<ConnRow[]>`select * from mail_connections where user_id = ${actor.id} and provider = 'gmail'`);
  return {
    configured: cfg.configured,
    connected: Boolean(c && c.status === "active"),
    status: c?.status ?? null,
    account: c ? decryptValue(c.account_email_encrypted) : null,
    canCreateDrafts: Boolean(c?.scopes.includes(GMAIL_SCOPES.compose)),
    cloudAiAllowed: c?.cloud_ai_allowed ?? false,
    connectedAt: c?.connected_at.toISOString() ?? null,
    lastError: c?.last_error ?? null,
  };
}

/** Step 1: a Google consent URL for the signed-in user (nothing is read yet). */
export async function startGmailConnect(actor: Actor, access: GmailAccess, ip?: string): Promise<{ url: string }> {
  const cfg = gmailConfig();
  if (!cfg.configured) throw new HttpError(409, "gmail_not_configured", "Gmail is not set up on this server yet");
  const a = newAuthRequest();
  await asUser(actor, async (tx) => {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from oauth_states where user_id = ${actor.id} and created_at > now() - interval '1 hour'`;
    if (n!.n >= 20) throw new HttpError(429, "too_many_attempts", "Too many connection attempts. Try again later.");
    await tx`insert into oauth_states (user_id, provider, state_hash, code_verifier_encrypted, access, expires_at)
             values (${actor.id}, 'gmail', ${sha(a.state)}, ${encryptValue(a.verifier)}, ${access}, now() + interval '10 minutes')`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "gmail.connect_started", subjectUserId: actor.id, ip, metadata: { access } }, tx);
  });
  return { url: authorizationUrl(cfg.endpoints, { clientId: cfg.clientId, redirectUri: cfg.redirectUri, scopes: scopesFor(access), state: a.state, challenge: a.challenge }) };
}

/**
 * Step 2: Google redirects back. The state must exist, belong to THIS user, be unused and
 * unexpired; it is consumed before the code is exchanged. The granted scopes must include
 * read access and nothing beyond what was asked.
 */
export async function finishGmailConnect(actor: Actor, q: { state: string | null; code: string | null; error: string | null }, ip?: string): Promise<{ account: string; canCreateDrafts: boolean }> {
  const cfg = gmailConfig();
  if (!cfg.configured) throw new HttpError(409, "gmail_not_configured", "Gmail is not set up on this server");
  if (!q.state || q.state.length > 200) throw badRequest("Missing or invalid state");
  const state = await asUser(actor, async (tx) => {
    const [s] = await tx<{ id: string; code_verifier_encrypted: string; access: GmailAccess; expires_at: Date; used_at: Date | null }[]>`
      select id, code_verifier_encrypted, access, expires_at, used_at from oauth_states
       where state_hash = ${sha(q.state!)} and user_id = ${actor.id} and provider = 'gmail' for update`;
    if (!s) throw new HttpError(400, "invalid_state", "This sign-in link is not valid for your account. Start again from the dashboard.");
    if (s.used_at) throw new HttpError(400, "state_used", "This sign-in link was already used. Start again.");
    await tx`update oauth_states set used_at = now() where id = ${s.id}`;
    return s;
  });
  if (state.expires_at.getTime() < Date.now()) throw new HttpError(400, "state_expired", "The sign-in took too long. Start again.");
  if (q.error) throw new HttpError(400, "access_denied", q.error === "access_denied" ? "You did not allow access to Gmail." : "Google reported an error.");
  if (!q.code || q.code.length > 2000) throw badRequest("Missing authorisation code");

  let tokens;
  try {
    tokens = await exchangeCode(http, cfg.endpoints, { clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, code: q.code, verifier: decryptValue(state.code_verifier_encrypted) });
  } catch (err) {
    throw gmailHttpError(err);
  }
  const asked = scopesFor(state.access);
  const granted = tokens.scopes.length ? tokens.scopes.filter((s) => s.startsWith("https://www.googleapis.com/auth/gmail")) : asked;
  if (!granted.includes(GMAIL_SCOPES.readonly)) throw new HttpError(400, "scope_missing", "Read access to Gmail was not granted, so Gmail was not connected.");
  const scopes = granted.filter((s) => asked.includes(s));
  if (!tokens.refreshToken) throw new HttpError(400, "no_refresh_token", "Google did not return long-term access. Remove the app's access in your Google account and connect again.");
  let profile;
  try {
    profile = await getProfile(http, cfg.endpoints, tokens.accessToken);
  } catch (err) {
    throw gmailHttpError(err);
  }
  await asUser(actor, async (tx) => {
    await tx`
      insert into mail_connections (user_id, provider, account_email_encrypted, scopes, refresh_token_encrypted, access_token_encrypted, access_expires_at, status, last_error)
      values (${actor.id}, 'gmail', ${encryptValue(profile.email)}, ${scopes}::text[], ${encryptValue(tokens.refreshToken!)}, ${encryptValue(tokens.accessToken)}, ${new Date(tokens.expiresAt)}, 'active', null)
      on conflict (user_id, provider) do update set account_email_encrypted = excluded.account_email_encrypted, scopes = excluded.scopes,
        refresh_token_encrypted = excluded.refresh_token_encrypted, access_token_encrypted = excluded.access_token_encrypted,
        access_expires_at = excluded.access_expires_at, status = 'active', last_error = null, connected_at = now()`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "gmail.connected", subjectUserId: actor.id, ip, metadata: { drafts: scopes.includes(GMAIL_SCOPES.compose) } }, tx);
  });
  return { account: profile.email, canCreateDrafts: scopes.includes(GMAIL_SCOPES.compose) };
}

/** Revokes the grant at Google and deletes the connection and everything derived from the mailbox here. */
export async function disconnectGmail(actor: Actor, ip?: string): Promise<{ revokedAtGoogle: boolean }> {
  const cfg = gmailConfig();
  const [c] = await asUser(actor, (tx) => tx<ConnRow[]>`select * from mail_connections where user_id = ${actor.id} and provider = 'gmail'`);
  if (!c) throw notFound("Gmail is not connected");
  let revoked = false;
  const token = c.refresh_token_encrypted ? decryptValue(c.refresh_token_encrypted) : c.access_token_encrypted ? decryptValue(c.access_token_encrypted) : null;
  if (token && cfg.configured) revoked = await revokeToken(http, cfg.endpoints, token).catch(() => false);
  await asUser(actor, async (tx) => {
    await tx`delete from message_insights where user_id = ${actor.id} and source = 'gmail'`;
    await tx`delete from message_drafts where user_id = ${actor.id} and channel = 'gmail'`;
    await tx`delete from mail_connections where id = ${c.id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "gmail.disconnected", subjectUserId: actor.id, ip, metadata: { revokedAtGoogle: revoked } }, tx);
  });
  return { revokedAtGoogle: revoked };
}

export async function setGmailCloudAi(actor: Actor, allowed: boolean, ip?: string): Promise<{ cloudAiAllowed: boolean }> {
  return asUser(actor, async (tx) => {
    const rows = await tx`update mail_connections set cloud_ai_allowed = ${allowed} where user_id = ${actor.id} and provider = 'gmail' returning id`;
    if (!rows.length) throw notFound("Gmail is not connected");
    await audit({ actorId: actor.id, actorRole: actor.role, action: allowed ? "gmail.cloud_ai_allowed" : "gmail.cloud_ai_revoked", subjectUserId: actor.id, ip }, tx);
    return { cloudAiAllowed: allowed };
  });
}

export function gmailHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof GmailError) {
    const status = err.code === "not_found" ? 404 : err.code === "rate_limited" ? 429 : err.code === "insufficient_scope" ? 403 : err.code === "token_revoked" || err.code === "not_authorized" ? 409 : 502;
    return new HttpError(status, `gmail_${err.code}`, err.message);
  }
  return new HttpError(502, "gmail_failed", "Gmail could not be reached");
}

export interface GmailSession {
  connectionId: string;
  token: string;
  account: string;
  scopes: string[];
  cloudAiAllowed: boolean;
}

/** A valid access token for the user's own connection (refreshed when needed). Never leaves the server. */
export async function gmailSession(actor: Actor): Promise<GmailSession> {
  const cfg = gmailConfig();
  if (!cfg.configured) throw new HttpError(409, "gmail_not_configured", "Gmail is not set up on this server");
  const [c] = await asUser(actor, (tx) => tx<ConnRow[]>`select * from mail_connections where user_id = ${actor.id} and provider = 'gmail'`);
  if (!c) throw new HttpError(409, "gmail_not_connected", "Connect Gmail first");
  if (c.status !== "active") throw new HttpError(409, "gmail_reconnect", "Gmail access was revoked or failed. Connect Gmail again.");
  const base = { connectionId: c.id, account: decryptValue(c.account_email_encrypted), scopes: c.scopes, cloudAiAllowed: c.cloud_ai_allowed };
  if (c.access_token_encrypted && c.access_expires_at && c.access_expires_at.getTime() > Date.now() + 30_000) return { ...base, token: decryptValue(c.access_token_encrypted) };
  if (!c.refresh_token_encrypted) throw new HttpError(409, "gmail_reconnect", "Connect Gmail again");
  try {
    const t = await refreshAccess(http, cfg.endpoints, { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: decryptValue(c.refresh_token_encrypted) });
    await asUser(actor, (tx) => tx`update mail_connections set access_token_encrypted = ${encryptValue(t.accessToken)}, access_expires_at = ${new Date(t.expiresAt)}, last_error = null where id = ${c.id}`);
    return { ...base, token: t.accessToken };
  } catch (err) {
    if (err instanceof GmailError && err.code === "token_revoked") {
      await asUser(actor, (tx) => tx`update mail_connections set status = 'revoked', access_token_encrypted = null, last_error = 'Access was revoked at Google' where id = ${c.id}`);
    } else {
      console.warn(`[gmail] access renewal failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
    throw gmailHttpError(err);
  }
}

// --- Reading ---------------------------------------------------------------------------------

export interface ThreadListItem {
  id: string;
  subject: string | null;
  from: string | null;
  lastFrom: string | null;
  date: string | null;
  unread: boolean;
  messageCount: number;
  needsReply: boolean;
}

/** Search (bounded page of threads). Nothing is read before the user connected Gmail. */
export async function searchMail(actor: Actor, s: MailSearch, pageToken: string | null): Promise<{ threads: ThreadListItem[]; nextPageToken: string | null; query: string }> {
  const session = await gmailSession(actor);
  const cfg = gmailConfig();
  let query: string;
  try {
    query = buildQuery(s);
  } catch {
    throw badRequest("Dates must be YYYY-MM-DD");
  }
  try {
    const r = await searchThreads(http, cfg.endpoints, session.token, query, pageToken);
    const threads: ThreadListItem[] = [];
    for (const id of r.ids) {
      const t = await getThread(http, cfg.endpoints, session.token, id, "metadata");
      const first = t.messages[0];
      const last = t.messages.at(-1);
      threads.push({
        id,
        subject: first?.subject ?? null,
        from: first?.from ? first.from.name ?? first.from.email : null,
        lastFrom: last?.from ? (last.from.email === session.account ? "You" : last.from.name ?? last.from.email) : null,
        date: last?.date ?? null,
        unread: t.messages.some((m) => m.unread),
        messageCount: t.messages.length + t.omitted,
        needsReply: needsReply(t, session.account),
      });
    }
    return { threads, nextPageToken: r.nextPageToken, query };
  } catch (err) {
    throw gmailHttpError(err);
  }
}

export async function readThread(actor: Actor, threadId: string): Promise<{ thread: MailThread; account: string; session: GmailSession }> {
  const session = await gmailSession(actor);
  try {
    return { thread: await getThread(http, gmailConfig().endpoints, session.token, threadId, "full"), account: session.account, session };
  } catch (err) {
    throw gmailHttpError(err);
  }
}

export function assertCanDraft(session: GmailSession) {
  if (!session.scopes.includes(GMAIL_SCOPES.compose)) throw new HttpError(403, "gmail_no_draft_access", "Gmail was connected read-only. Reconnect with “read and create drafts” to create drafts in Gmail.");
}

export const gmailHttp = () => http;
