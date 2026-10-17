/**
 * Messaging (migration 0021) against a real PostgreSQL: RLS isolation for connections,
 * OAuth states, imported chats, insights and drafts; encrypted-value and scope checks;
 * draft rules (no WhatsApp "send" states, Gmail drafts only for approved content,
 * idempotency); cascade deletion. Synthetic data only. Run with `npm run test:db`.
 */
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ensureAppRole, migrate, withUser, type Db } from "../../packages/db/src";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_APP_URL;
const APP_PASSWORD = process.env.TEST_DB_APP_PASSWORD ?? "test_app_password_1234";
const MIGRATIONS = path.resolve(__dirname, "../migrations");
const run = OWNER_URL && APP_URL ? describe : describe.skip;
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

run("messaging (0021)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const as = <T>(key: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role: "CUSTOMER" }, fn);
  let conn = "";
  let chat = "";

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });
    for (const k of ["m_alice", "m_bob"]) {
      const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${k}@msg.test`}, ${k}, 'x', 'CUSTOMER') returning id`;
      ids[k] = u!.id;
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("OAuth states are owner-only, single-use, and hold only an encrypted verifier", async () => {
    await as("m_alice", (tx) => tx`insert into oauth_states (user_id, provider, state_hash, code_verifier_encrypted, access, expires_at) values (${ids.m_alice!}, 'gmail', ${"a".repeat(64)}, 'enc:k1:x:y:z', 'read', now() + interval '10 minutes')`);
    expect(await as("m_bob", (tx) => tx`select id from oauth_states`)).toHaveLength(0);
    await expect(as("m_alice", (tx) => tx`insert into oauth_states (user_id, provider, state_hash, code_verifier_encrypted, access, expires_at) values (${ids.m_alice!}, 'gmail', ${"b".repeat(64)}, 'plain-verifier', 'read', now())`)).rejects.toThrow(/check constraint/);
    await expect(as("m_alice", (tx) => tx`update oauth_states set expires_at = now() + interval '1 year'`)).rejects.toThrow(/permission denied/);
    expect(await as("m_alice", (tx) => tx`update oauth_states set used_at = now() where used_at is null returning id`)).toHaveLength(1);
  });

  it("connections: encrypted tokens, only Gmail read/compose scopes (read always included), one per user, owner-only", async () => {
    const [c] = await as("m_alice", (tx) => tx<{ id: string }[]>`
      insert into mail_connections (user_id, provider, account_email_encrypted, scopes, refresh_token_encrypted)
      values (${ids.m_alice!}, 'gmail', 'enc:k1:a:b:c', ${[READ, COMPOSE]}::text[], 'enc:k1:r:t:x') returning id`);
    conn = c!.id;
    for (const scopes of [[COMPOSE], [READ, "https://mail.google.com/"], [READ, "https://www.googleapis.com/auth/gmail.send"]]) {
      await expect(as("m_bob", (tx) => tx`insert into mail_connections (user_id, provider, account_email_encrypted, scopes) values (${ids.m_bob!}, 'gmail', 'enc:x', ${scopes}::text[])`), scopes.join()).rejects.toThrow(/check constraint/);
    }
    await expect(as("m_bob", (tx) => tx`insert into mail_connections (user_id, provider, account_email_encrypted, scopes, refresh_token_encrypted) values (${ids.m_bob!}, 'gmail', 'enc:x', ${[READ]}::text[], 'ya29.plain-token')`)).rejects.toThrow(/check constraint/);
    await expect(as("m_alice", (tx) => tx`insert into mail_connections (user_id, provider, account_email_encrypted, scopes) values (${ids.m_alice!}, 'gmail', 'enc:x', ${[READ]}::text[])`)).rejects.toThrow(/duplicate key/);
    expect(await as("m_bob", (tx) => tx`select id from mail_connections`)).toHaveLength(0);
    expect(await as("m_bob", (tx) => tx`update mail_connections set cloud_ai_allowed = true returning id`)).toHaveLength(0);
  });

  it("imported chats and messages are owner-only and encrypted; cross-user messages refused", async () => {
    const [c] = await as("m_alice", (tx) => tx<{ id: string }[]>`
      insert into whatsapp_chats (user_id, title_encrypted, file_sha256, format, date_order, message_count)
      values (${ids.m_alice!}, 'enc:t', ${"c".repeat(64)}, 'android', 'dmy', 2) returning id`);
    chat = c!.id;
    await as("m_alice", (tx) => tx`insert into whatsapp_messages (chat_id, user_id, seq, kind, text_encrypted) values (${chat}, ${ids.m_alice!}, 1, 'text', 'enc:hello')`);
    await expect(as("m_alice", (tx) => tx`insert into whatsapp_messages (chat_id, user_id, seq, kind, text_encrypted) values (${chat}, ${ids.m_alice!}, 2, 'text', 'plain hello')`)).rejects.toThrow(/check constraint/);
    await expect(as("m_bob", (tx) => tx`insert into whatsapp_messages (chat_id, user_id, seq, kind, text_encrypted) values (${chat}, ${ids.m_bob!}, 3, 'text', 'enc:x')`)).rejects.toThrow(/another user/);
    expect(await as("m_bob", (tx) => tx`select id from whatsapp_messages`)).toHaveLength(0);
    expect(await as("m_bob", (tx) => tx`select id from whatsapp_chats`)).toHaveLength(0);
    await expect(as("m_alice", (tx) => tx`insert into whatsapp_chats (user_id, title_encrypted, file_sha256, format, date_order, message_count) values (${ids.m_alice!}, 'enc:t2', ${"c".repeat(64)}, 'ios', 'mdy', 1)`)).rejects.toThrow(/duplicate key/);
    // Messages cannot be edited by the app.
    await expect(as("m_alice", (tx) => tx`update whatsapp_messages set text_encrypted = 'enc:changed'`)).rejects.toThrow(/permission denied/);
  });

  it("drafts: idempotent, no send states for WhatsApp, Gmail drafts only for approved content, own chat/connection only", async () => {
    const gmail = (key: string, extra = "") =>
      as("m_alice", (tx) => tx`
        insert into message_drafts (user_id, channel, connection_id, thread_ref, recipients_encrypted, body_encrypted, idempotency_key, status${tx.unsafe(extra ? ", approved_content_sha, approved_at" : "")})
        values (${ids.m_alice!}, 'gmail', ${conn}, '18f0aa00', 'enc:to', 'enc:body', ${key}, ${extra || "draft"}${extra ? tx`, ${"d".repeat(64)}, now()` : tx``})`);
    await gmail("task-0001");
    await expect(gmail("task-0001")).rejects.toThrow(/duplicate key/);
    await expect(as("m_alice", (tx) => tx`insert into message_drafts (user_id, channel, connection_id, thread_ref, recipients_encrypted, body_encrypted, idempotency_key, status) values (${ids.m_alice!}, 'gmail', ${conn}, 't1', 'enc:to', 'enc:b', 'task-0002', 'approved')`)).rejects.toThrow(/check constraint/);
    await expect(as("m_alice", (tx) => tx`update message_drafts set status = 'created' where idempotency_key = 'task-0001'`)).rejects.toThrow(/check constraint/);
    // WhatsApp: copy only.
    await as("m_alice", (tx) => tx`insert into message_drafts (user_id, channel, thread_ref, body_encrypted, idempotency_key) values (${ids.m_alice!}, 'whatsapp', ${chat}, 'enc:hi', 'task-wa-01')`);
    await expect(as("m_alice", (tx) => tx`update message_drafts set status = 'approved', approved_content_sha = ${"e".repeat(64)}, approved_at = now() where idempotency_key = 'task-wa-01'`)).rejects.toThrow(/check constraint/);
    // Bob cannot draft into Alice's chat or through Alice's connection.
    await expect(as("m_bob", (tx) => tx`insert into message_drafts (user_id, channel, thread_ref, body_encrypted, idempotency_key) values (${ids.m_bob!}, 'whatsapp', ${chat}, 'enc:x', 'bob-00001')`)).rejects.toThrow(/another user/);
    await expect(as("m_bob", (tx) => tx`insert into message_drafts (user_id, channel, connection_id, thread_ref, recipients_encrypted, body_encrypted, idempotency_key) values (${ids.m_bob!}, 'gmail', ${conn}, 't', 'enc:to', 'enc:x', 'bob-00002')`)).rejects.toThrow(/another user/);
    expect(await as("m_bob", (tx) => tx`select id from message_drafts`)).toHaveLength(0);
  });

  it("insights are owner-only and deletable but not editable; deleting a chat removes its messages", async () => {
    await as("m_alice", (tx) => tx`insert into message_insights (user_id, source, ref, content_encrypted, provider) values (${ids.m_alice!}, 'whatsapp', ${chat}, 'enc:summary', 'rules')`);
    expect(await as("m_bob", (tx) => tx`select id from message_insights`)).toHaveLength(0);
    await expect(as("m_alice", (tx) => tx`update message_insights set content_encrypted = 'enc:x'`)).rejects.toThrow(/permission denied/);
    expect(await as("m_alice", (tx) => tx`delete from message_insights returning id`)).toHaveLength(1);
    expect(await as("m_alice", (tx) => tx`delete from whatsapp_chats where id = ${chat} returning id`)).toHaveLength(1);
    expect(await db.system`select id from whatsapp_messages where chat_id = ${chat}`).toHaveLength(0);
  });
});
