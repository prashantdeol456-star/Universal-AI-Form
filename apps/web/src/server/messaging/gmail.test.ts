import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory stand-in for the two tables the Gmail service touches (no real database or network).
vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({
  states: [] as Array<{ id: string; user_id: string; state_hash: string; code_verifier_encrypted: string; access: string; expires_at: Date; used_at: Date | null }>,
  conns: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  audits: [] as string[],
  env: { GMAIL_OAUTH_CLIENT_ID: "cid", GMAIL_OAUTH_CLIENT_SECRET: "secret", GMAIL_OAUTH_REDIRECT_URI: "", APP_URL: "https://app.example", NODE_ENV: "test", GOOGLE_OAUTH_AUTH_URL: "", GOOGLE_OAUTH_TOKEN_URL: "", GOOGLE_OAUTH_REVOKE_URL: "", GMAIL_API_BASE: "" } as Record<string, string>,
}));
vi.mock("../env", () => ({ env: () => db.env }));
vi.mock("../audit", () => ({ audit: async (e: { action: string }) => void db.audits.push(e.action) }));
vi.mock("../db", () => ({
  encryptValue: (s: string) => `enc:${Buffer.from(s).toString("base64")}`,
  decryptValue: (s: string) => Buffer.from(s.slice(4), "base64").toString("utf8"),
  asUser: async (actor: { id: string }, fn: (tx: unknown) => unknown) =>
    fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join("?");
      if (/count\(\*\).*oauth_states/s.test(sql)) return [{ n: 0 }];
      if (/insert into oauth_states/.test(sql)) return void db.states.push({ id: `s${db.states.length}`, user_id: v[0] as string, state_hash: v[1] as string, code_verifier_encrypted: v[2] as string, access: v[3] as string, expires_at: new Date(Date.now() + 600_000), used_at: null }), [];
      if (/from oauth_states/.test(sql)) return db.states.filter((s) => s.state_hash === v[0] && s.user_id === v[1]);
      if (/update oauth_states set used_at/.test(sql)) return void (db.states.find((s) => s.id === v[0])!.used_at = new Date()), [];
      if (/insert into mail_connections/.test(sql)) {
        db.conns = db.conns.filter((c) => c.user_id !== v[0]);
        db.conns.push({ id: "c1", user_id: v[0], account_email_encrypted: v[1], scopes: v[2], refresh_token_encrypted: v[3], access_token_encrypted: v[4], access_expires_at: v[5], status: "active", cloud_ai_allowed: false, last_error: null, connected_at: new Date() });
        return [];
      }
      if (/select \* from mail_connections/.test(sql)) return db.conns.filter((c) => c.user_id === actor.id);
      if (/update mail_connections set access_token_encrypted = \?/.test(sql)) return void Object.assign(db.conns[0]!, { access_token_encrypted: v[0], access_expires_at: v[1] }), [];
      if (/update mail_connections set status = 'revoked'/.test(sql)) return void Object.assign(db.conns[0]!, { status: "revoked" }), [];
      if (/^delete from (\w+)/.test(sql.trim())) return void db.deleted.push(/delete from (\w+)/.exec(sql)![1]!), [];
      return [];
    }),
}));

const { finishGmailConnect, gmailSession, gmailStatus, setGmailHttp, startGmailConnect, disconnectGmail } = await import("./gmail");
const alice = { id: "a0000000-0000-4000-8000-000000000001", role: "CUSTOMER" } as never;
const bob = { id: "b0000000-0000-4000-8000-000000000002", role: "CUSTOMER" } as never;
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

let google: { token: unknown; tokenStatus: number; profile: unknown; calls: string[] };
beforeEach(() => {
  db.states = [];
  db.conns = [];
  db.deleted = [];
  db.audits = [];
  db.env.GMAIL_OAUTH_CLIENT_ID = "cid";
  google = { token: { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: `${READ} ${COMPOSE}` }, tokenStatus: 200, profile: { emailAddress: "asha@example.test" }, calls: [] };
  setGmailHttp(async (url: string, init?: { method?: string; body?: string }) => {
    google.calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}${init?.body ? ` ${init.body}` : ""}`);
    const body = url.includes("/token") ? google.token : url.includes("/revoke") ? {} : url.includes("/profile") ? google.profile : {};
    const status = url.includes("/token") ? google.tokenStatus : 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  });
});

async function begin(access: "read" | "read_draft" = "read_draft") {
  const { url } = await startGmailConnect(alice, access);
  return new URL(url).searchParams.get("state")!;
}

describe("Gmail OAuth flow", () => {
  it("is off without client credentials (no URL, no connection)", async () => {
    db.env.GMAIL_OAUTH_CLIENT_ID = "";
    await expect(startGmailConnect(alice, "read")).rejects.toMatchObject({ status: 409, code: "gmail_not_configured" });
    expect((await gmailStatus(alice)).configured).toBe(false);
  });

  it("stores only a hash of the state and an encrypted verifier; asks for the chosen scopes only", async () => {
    const { url } = await startGmailConnect(alice, "read");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(READ);
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/api/integrations/gmail/callback");
    const st = u.searchParams.get("state")!;
    expect(db.states[0]!.state_hash).toBe(createHash("sha256").update(st).digest("hex"));
    expect(db.states[0]!.code_verifier_encrypted).toMatch(/^enc:/);
    expect(JSON.stringify(db.states)).not.toContain(st);
  });

  it("connects: verifier sent to Google, tokens encrypted, nothing read before", async () => {
    const state = await begin();
    const r = await finishGmailConnect(alice, { state, code: "CODE", error: null });
    expect(r).toEqual({ account: "asha@example.test", canCreateDrafts: true });
    expect(google.calls[0]).toMatch(/^POST https:\/\/oauth2\.googleapis\.com\/token .*code_verifier=/);
    expect(google.calls.filter((c) => c.includes("gmail.googleapis.com"))).toEqual(["GET https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
    expect(String(db.conns[0]!.refresh_token_encrypted)).toMatch(/^enc:/);
    expect(JSON.stringify(db.conns)).not.toContain('"RT"');
    expect(db.audits).toContain("gmail.connected");
  });

  it("refuses a state from another user, a reused state, an expired state, and user refusal", async () => {
    const state = await begin();
    await expect(finishGmailConnect(bob, { state, code: "CODE", error: null })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(finishGmailConnect(alice, { state: "forged", code: "CODE", error: null })).rejects.toMatchObject({ code: "invalid_state" });
    await finishGmailConnect(alice, { state, code: "CODE", error: null });
    await expect(finishGmailConnect(alice, { state, code: "CODE", error: null })).rejects.toMatchObject({ code: "state_used" });
    const s2 = await begin();
    db.states.at(-1)!.expires_at = new Date(Date.now() - 1000);
    await expect(finishGmailConnect(alice, { state: s2, code: "CODE", error: null })).rejects.toMatchObject({ code: "state_expired" });
    const s3 = await begin();
    await expect(finishGmailConnect(alice, { state: s3, code: null, error: "access_denied" })).rejects.toMatchObject({ code: "access_denied" });
    await expect(finishGmailConnect(alice, { state: null, code: "x", error: null })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses when read access was not granted, keeps only scopes it asked for, needs a refresh token", async () => {
    google.token = { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: COMPOSE };
    await expect(finishGmailConnect(alice, { state: await begin(), code: "C", error: null })).rejects.toMatchObject({ code: "scope_missing" });
    google.token = { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: `${READ} ${COMPOSE} https://www.googleapis.com/auth/gmail.send` };
    const r = await finishGmailConnect(alice, { state: await begin("read"), code: "C", error: null });
    expect(r.canCreateDrafts).toBe(false);
    expect(db.conns[0]!.scopes).toEqual([READ]);
    google.token = { access_token: "AT", expires_in: 3600, scope: READ };
    await expect(finishGmailConnect(alice, { state: await begin("read"), code: "C", error: null })).rejects.toMatchObject({ code: "no_refresh_token" });
    google.tokenStatus = 400;
    await expect(finishGmailConnect(alice, { state: await begin("read"), code: "C", error: null })).rejects.toMatchObject({ code: "gmail_not_authorized" });
  });
});

describe("Gmail session and disconnect", () => {
  it("refreshes an expired access token and marks a revoked grant", async () => {
    await finishGmailConnect(alice, { state: await begin(), code: "C", error: null });
    db.conns[0]!.access_expires_at = new Date(Date.now() - 1000);
    google.token = { access_token: "AT2", expires_in: 3600 };
    expect((await gmailSession(alice)).token).toBe("AT2");
    db.conns[0]!.access_expires_at = new Date(Date.now() - 1000);
    google.tokenStatus = 400;
    await expect(gmailSession(alice)).rejects.toMatchObject({ code: "gmail_token_revoked" });
    expect(db.conns[0]!.status).toBe("revoked");
    await expect(gmailSession(alice)).rejects.toMatchObject({ code: "gmail_reconnect" });
    await expect(gmailSession(bob)).rejects.toMatchObject({ code: "gmail_not_connected" });
  });

  it("disconnect revokes at Google and deletes derived data", async () => {
    await finishGmailConnect(alice, { state: await begin(), code: "C", error: null });
    const r = await disconnectGmail(alice);
    expect(r.revokedAtGoogle).toBe(true);
    expect(google.calls.some((c) => /^POST https:\/\/oauth2\.googleapis\.com\/revoke token=RT/.test(c))).toBe(true);
    expect(db.deleted).toEqual(expect.arrayContaining(["message_insights", "message_drafts", "mail_connections"]));
  });

  it("endpoint overrides are ignored in production", async () => {
    db.env.NODE_ENV = "production";
    db.env.GOOGLE_OAUTH_AUTH_URL = "https://evil.example/auth";
    const { url } = await startGmailConnect(alice, "read");
    expect(url.startsWith("https://accounts.google.com/")).toBe(true);
    db.env.NODE_ENV = "test";
    db.env.GOOGLE_OAUTH_AUTH_URL = "";
  });
});
