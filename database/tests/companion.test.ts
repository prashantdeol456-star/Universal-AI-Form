/**
 * Local companion (migration 0022) against a real PostgreSQL: pairing rows invisible to the
 * runtime role, devices with no capabilities by default and only known capabilities, revoked
 * devices stay revoked, tokens cannot be changed, folders cannot be added by the runtime role,
 * owner-only workflows/preferences/feedback, local step types. Synthetic data only.
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
const h = (c: string) => c.repeat(64);

run("local companion (0022)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const as = <T>(key: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role: "CUSTOMER" }, fn);
  let device = "";
  let task = "";

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });
    for (const k of ["c_alice", "c_bob"]) {
      const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${k}@companion.test`}, ${k}, 'x', 'CUSTOMER') returning id`;
      ids[k] = u!.id;
    }
    const [d] = await db.system<{ id: string }[]>`
      insert into companion_devices (user_id, name, platform, companion_version, token_hash) values (${ids.c_alice!}, 'Laptop', 'windows', '0.1.0', ${h("a")}) returning id`;
    device = d!.id;
    const [t] = await db.system<{ id: string }[]>`insert into tasks (user_id, title, task_type) values (${ids.c_alice!}, 'Summarise', 'local_summarize_files') returning id`;
    task = t!.id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it("pairings are invisible to the runtime role", async () => {
    await db.system`insert into companion_pairings (code_hash, poll_secret_hash, device_name, platform, companion_version, expires_at) values (${h("1")}, ${h("2")}, 'PC', 'linux', '0.1.0', now() + interval '10 minutes')`;
    await expect(as("c_alice", (tx) => tx`select id from companion_pairings`)).rejects.toThrow(/permission denied/);
    await expect(as("c_alice", (tx) => tx`insert into companion_pairings (code_hash, poll_secret_hash, device_name, platform, companion_version, expires_at) values (${h("3")}, ${h("4")}, 'PC', 'linux', '0.1.0', now())`)).rejects.toThrow(/permission denied|row-level security/);
  });

  it("devices start with no capabilities, accept only known ones, and are owner-only", async () => {
    const [d] = await as("c_alice", (tx) => tx<{ capabilities: string[]; ai_excerpts_allowed: boolean; cloud_ai_allowed: boolean }[]>`select capabilities, ai_excerpts_allowed, cloud_ai_allowed from companion_devices`);
    expect(d).toEqual({ capabilities: [], ai_excerpts_allowed: false, cloud_ai_allowed: false });
    expect(await as("c_alice", (tx) => tx`update companion_devices set capabilities = ${["list_approved_folders", "read_selected_files"]}::text[] where id = ${device} returning id`)).toHaveLength(1);
    for (const bad of [["capture_screen_with_approval"], ["shell"], ["interact_with_approved_application"]]) {
      await expect(as("c_alice", (tx) => tx`update companion_devices set capabilities = ${bad}::text[] where id = ${device}`), bad[0]).rejects.toThrow(/check constraint/);
    }
    await expect(as("c_alice", (tx) => tx`update companion_devices set cloud_ai_allowed = true where id = ${device}`)).rejects.toThrow(/check constraint/);
    expect(await as("c_bob", (tx) => tx`select id from companion_devices`)).toHaveLength(0);
    expect(await as("c_bob", (tx) => tx`update companion_devices set stop_requested_at = now() returning id`)).toHaveLength(0);
  });

  it("the runtime role cannot create devices, change tokens or add folders", async () => {
    await expect(as("c_alice", (tx) => tx`insert into companion_devices (user_id, name, platform, companion_version, token_hash) values (${ids.c_alice!}, 'X', 'linux', '1', ${h("b")})`)).rejects.toThrow(/permission denied/);
    await expect(as("c_alice", (tx) => tx`update companion_devices set token_hash = ${h("c")} where id = ${device}`)).rejects.toThrow(/permission denied/);
    await expect(as("c_alice", (tx) => tx`insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access) values (gen_random_uuid(), ${device}, ${ids.c_alice!}, 'enc:l', 'enc:p', ${["read"]}::text[])`)).rejects.toThrow(/permission denied/);
    await expect(db.system`update companion_devices set token_hash = ${h("d")} where id = ${device}`).rejects.toThrow(/cannot be changed/);
  });

  it("folders: owner-only, encrypted display copies, known access only; revocable by the owner", async () => {
    const f = "7a1d0c7e-1111-4111-8111-111111111111";
    await db.system`insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access) values (${f}, ${device}, ${ids.c_alice!}, 'enc:l', 'enc:p', ${["read", "write"]}::text[])`;
    await expect(db.system`insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access) values (gen_random_uuid(), ${device}, ${ids.c_alice!}, 'Invoices', 'enc:p', ${["read"]}::text[])`).rejects.toThrow(/check constraint/);
    await expect(db.system`insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access) values (gen_random_uuid(), ${device}, ${ids.c_alice!}, 'enc:l', 'enc:p', ${["delete"]}::text[])`).rejects.toThrow(/check constraint/);
    // Folder rows must belong to the device's owner.
    await expect(db.system`insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access) values (gen_random_uuid(), ${device}, ${ids.c_bob!}, 'enc:l', 'enc:p', ${["read"]}::text[])`).rejects.toThrow(/foreign key/);
    expect(await as("c_bob", (tx) => tx`select id from companion_folders`)).toHaveLength(0);
    await expect(as("c_alice", (tx) => tx`update companion_folders set access = ${["read", "write", "run"]}::text[]`)).rejects.toThrow(/permission denied/);
    expect(await as("c_alice", (tx) => tx`update companion_folders set revoked_at = now() where id = ${f} returning id`)).toHaveLength(1);
  });

  it("a revoked device stays revoked", async () => {
    const [d] = await db.system<{ id: string }[]>`insert into companion_devices (user_id, name, platform, companion_version, token_hash) values (${ids.c_alice!}, 'Old', 'linux', '0.1.0', ${h("e")}) returning id`;
    await as("c_alice", (tx) => tx`update companion_devices set status = 'revoked', revoked_at = now() where id = ${d!.id}`);
    await expect(as("c_alice", (tx) => tx`update companion_devices set status = 'active', revoked_at = null where id = ${d!.id}`)).rejects.toThrow(/was revoked/);
  });

  it("local step types are allowed; unknown kinds are not", async () => {
    await db.system`insert into task_steps (task_id, user_id, step_key, step_type, title, sequence_number) values (${task}, ${ids.c_alice!}, 'list', 'local.list_files', 'List', 0)`;
    await expect(db.system`insert into task_steps (task_id, user_id, step_key, step_type, title, sequence_number) values (${task}, ${ids.c_alice!}, 'x', 'shell.run', 'X', 1)`).rejects.toThrow(/check constraint/);
  });

  it("workflows, preferences and feedback are owner-only; cross-user task references refused", async () => {
    await as("c_alice", (tx) => tx`insert into agent_workflows (user_id, name, task_type, source_task_id) values (${ids.c_alice!}, 'Monthly invoices', 'local_summarize_files', ${task})`);
    await expect(as("c_bob", (tx) => tx`insert into agent_workflows (user_id, name, task_type, source_task_id) values (${ids.c_bob!}, 'Steal', 'local_summarize_files', ${task})`)).rejects.toThrow(/another user/);
    expect(await as("c_bob", (tx) => tx`select id from agent_workflows`)).toHaveLength(0);
    await as("c_alice", (tx) => tx`insert into agent_preferences (user_id, key, value) values (${ids.c_alice!}, 'report_format', 'md')`);
    await expect(as("c_alice", (tx) => tx`insert into agent_preferences (user_id, key, value) values (${ids.c_alice!}, 'skip_approvals', 'true')`)).rejects.toThrow(/check constraint/);
    expect(await as("c_bob", (tx) => tx`select id from agent_preferences`)).toHaveLength(0);
    await as("c_alice", (tx) => tx`insert into task_feedback (task_id, user_id, correct, scope, note_encrypted) values (${task}, ${ids.c_alice!}, false, 'future', 'enc:n')`);
    await expect(as("c_bob", (tx) => tx`insert into task_feedback (task_id, user_id, correct) values (${task}, ${ids.c_bob!}, true)`)).rejects.toThrow(/foreign key|row-level/);
    await expect(as("c_alice", (tx) => tx`insert into task_feedback (task_id, user_id, correct, note_encrypted) values (${task}, ${ids.c_alice!}, true, 'plain note')`)).rejects.toThrow(/check constraint/);
  });

  it("deleting the user removes devices, folders, workflows, preferences and feedback", async () => {
    await db.system`delete from users where id = ${ids.c_alice!}`;
    for (const t of ["companion_devices", "companion_folders", "agent_workflows", "agent_preferences", "task_feedback"]) {
      const [r] = await db.system.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t} where user_id = $1`, [ids.c_alice!]);
      expect(r!.n, t).toBe(0);
    }
  });
});
