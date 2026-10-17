/**
 * Multi-agent missions (migration 0023) against a real PostgreSQL: owner-only missions and
 * parts, encrypted request and review, a part's plan cannot be changed after planning, parts
 * can only use the owner's devices and tasks, known agents/types only, cascades. Synthetic data.
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

run("agent missions (0023)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const as = <T>(key: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role: "CUSTOMER" }, fn);
  let mission = "";
  let part = "";

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });
    for (const k of ["ms_alice", "ms_bob"]) {
      const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${k}@missions.test`}, ${k}, 'x', 'CUSTOMER') returning id`;
      ids[k] = u!.id;
      const [d] = await db.system<{ id: string }[]>`insert into companion_devices (user_id, name, platform, companion_version, token_hash) values (${u!.id}, 'PC', 'linux', '0.1.0', ${(k === "ms_alice" ? "a" : "b").repeat(64)}) returning id`;
      ids[`${k}_dev`] = d!.id;
      const [t] = await db.system<{ id: string }[]>`insert into tasks (user_id, title, task_type) values (${u!.id}, 'T', 'local_summarize_files') returning id`;
      ids[`${k}_task`] = t!.id;
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("missions are owner-only with an encrypted request", async () => {
    const [m] = await as("ms_alice", (tx) => tx<{ id: string }[]>`insert into agent_missions (user_id, title, request_encrypted) values (${ids.ms_alice!}, 'Mission', 'enc:r') returning id`);
    mission = m!.id;
    await expect(as("ms_alice", (tx) => tx`insert into agent_missions (user_id, title, request_encrypted) values (${ids.ms_alice!}, 'M', 'plain request')`)).rejects.toThrow(/check constraint/);
    expect(await as("ms_bob", (tx) => tx`select id from agent_missions`)).toHaveLength(0);
    expect(await as("ms_bob", (tx) => tx`update agent_missions set status = 'cancelled' returning id`)).toHaveLength(0);
    await expect(as("ms_alice", (tx) => tx`update agent_missions set status = 'exploding' where id = ${mission}`)).rejects.toThrow(/check constraint/);
    await expect(as("ms_alice", (tx) => tx`update agent_missions set review_encrypted = 'plain' where id = ${mission}`)).rejects.toThrow(/check constraint/);
  });

  it("parts use only the owner's devices and tasks, known agents and local task types", async () => {
    const [p] = await as("ms_alice", (tx) => tx<{ id: string }[]>`
      insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation)
      values (${mission}, ${ids.ms_alice!}, 1, 1, 'file', ${ids.ms_alice_dev!}, 'local_summarize_files', '{}'::jsonb, 'Summarise') returning id`);
    part = p!.id;
    await expect(as("ms_alice", (tx) => tx`insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation) values (${mission}, ${ids.ms_alice!}, 2, 1, 'file', ${ids.ms_bob_dev!}, 'local_summarize_files', '{}'::jsonb, 'x')`)).rejects.toThrow(/foreign key/);
    await expect(as("ms_alice", (tx) => tx`insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation) values (${mission}, ${ids.ms_alice!}, 2, 1, 'shell', ${ids.ms_alice_dev!}, 'local_summarize_files', '{}'::jsonb, 'x')`)).rejects.toThrow(/check constraint/);
    await expect(as("ms_alice", (tx) => tx`insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation) values (${mission}, ${ids.ms_alice!}, 2, 1, 'file', ${ids.ms_alice_dev!}, 'draft_email', '{}'::jsonb, 'x')`)).rejects.toThrow(/check constraint/);
    await expect(as("ms_alice", (tx) => tx`update agent_mission_tasks set task_id = ${ids.ms_bob_task!} where id = ${part}`)).rejects.toThrow(/another user/);
    expect(await as("ms_alice", (tx) => tx`update agent_mission_tasks set task_id = ${ids.ms_alice_task!}, status = 'running', attempts = 1 where id = ${part} returning id`)).toHaveLength(1);
    expect(await as("ms_bob", (tx) => tx`select id from agent_mission_tasks`)).toHaveLength(0);
  });

  it("a part's plan (agent, device, type, input) cannot be changed after planning", async () => {
    for (const set of ["agent = 'command'", "task_type = 'local_run_command'", "input = '{\"commandId\":\"npm_build\"}'::jsonb", `device_id = '${ids.ms_alice_dev}'`]) {
      await expect(as("ms_alice", (tx) => tx.unsafe(`update agent_mission_tasks set ${set} where id = '${part}'`)), set).rejects.toThrow(/permission denied/);
    }
    await expect(as("ms_alice", (tx) => tx`update agent_mission_tasks set attempts = 6 where id = ${part}`)).rejects.toThrow(/check constraint/);
  });

  it("deleting the mission removes its parts; deleting the user removes missions", async () => {
    const [m2] = await as("ms_alice", (tx) => tx<{ id: string }[]>`insert into agent_missions (user_id, title, request_encrypted) values (${ids.ms_alice!}, 'M2', 'enc:x') returning id`);
    await as("ms_alice", (tx) => tx`insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation) values (${m2!.id}, ${ids.ms_alice!}, 1, 1, 'command', ${ids.ms_alice_dev!}, 'local_run_command', '{}'::jsonb, 'x')`);
    await as("ms_alice", (tx) => tx`delete from agent_missions where id = ${m2!.id}`);
    expect(await as("ms_alice", (tx) => tx`select id from agent_mission_tasks where mission_id = ${m2!.id}`)).toHaveLength(0);
    await db.system`delete from users where id = ${ids.ms_alice!}`;
    const [r] = await db.system<{ n: number }[]>`select count(*)::int as n from agent_missions where user_id = ${ids.ms_alice!}`;
    expect(r!.n).toBe(0);
  });
});
