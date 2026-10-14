/**
 * Task engine (migration 0016) against a real PostgreSQL: RLS isolation, state machine,
 * leases and recovery, approvals. Mock step handlers only; no network, no real accounts.
 * Run with `npm run test:db`.
 */
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ensureAppRole, migrate, withUser, type Db } from "../../packages/db/src";
import { TaskTransitionError } from "../../packages/shared/src/tasks";
import { createTaskEngine, TaskError, type ApprovalSpec, type ServerStepHandler, type TaskEngine, type TaskTemplate } from "../../packages/tasks/src";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_APP_URL;
const APP_PASSWORD = process.env.TEST_DB_APP_PASSWORD ?? "test_app_password_1234";
const MIGRATIONS = path.resolve(__dirname, "../migrations");
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run("task engine (0016)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const actor = (key: string) => ({ id: ids[key]!, role: "CUSTOMER" });

  // Mock behaviour, switched per test.
  const calls: string[] = [];
  let failNext = 0;
  let duringStep: (() => Promise<void>) | null = null;
  let effects = 0;

  const handlers: Record<string, ServerStepHandler> = {
    "server.echo": async (ctx) => {
      calls.push(`${ctx.taskId}:${ctx.stepKey}`);
      if (duringStep) await duringStep();
      if (failNext > 0) {
        failNext--;
        throw new Error("upstream said password=hunter2 and Bearer abc.def");
      }
      return { result: { n: calls.length }, secret: `secret output of ${ctx.stepKey}` };
    },
  };
  const approvals: Record<string, ApprovalSpec> = {
    "approval.ok": {
      actionType: "test.write",
      summary: () => "Write test data",
      payload: (ctx) => ({ from: ctx.previous.a?.secret ?? null }),
      effect: async () => {
        effects++;
        return { wrote: true };
      },
    },
  };
  const tpl = (steps: TaskTemplate["steps"]): TaskTemplate => ({ parse: (i) => (i ?? {}) as Record<string, never>, defaultTitle: () => "Test task", steps });
  const templates: Record<string, TaskTemplate> = {
    two_steps: tpl(() => [
      { key: "a", type: "server.echo", title: "Step A" },
      { key: "b", type: "server.echo", title: "Step B" },
    ]),
    risky: tpl(() => [{ key: "a", type: "server.echo", title: "Risky step", idempotent: false }]),
    gated: tpl(() => [
      { key: "a", type: "server.echo", title: "Prepare" },
      { key: "ok", type: "approval.ok", title: "Approve" },
    ]),
    browser: tpl(() => [{ key: "read", type: "browser.read_page", title: "Read page" }]),
  };
  const make = (o: { leaseMs?: number; approvalTtlMs?: number } = {}): TaskEngine =>
    createTaskEngine({ db, templates, serverHandlers: handlers, approvals, encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, ""), ...o });
  let engine: TaskEngine;

  async function createUser(key: string) {
    const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${key}@tasks.test`}, ${key}, 'x', 'CUSTOMER') returning id`;
    ids[key] = u!.id;
  }
  /** Runs the runner until nothing is claimable. */
  const drain = async (e = engine) => {
    for (let i = 0; i < 20 && (await e.runOnce("test-runner")) > 0; i++);
  };
  const statusOf = async (id: string) => (await db.system<{ status: string }[]>`select status from tasks where id = ${id}`)[0]!.status;

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 6 });
    for (const k of ["t_alice", "t_bob"]) await createUser(k);
    engine = make();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("runs a task to completion, saving each step and encrypting step output", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "two_steps" });
    expect(task.status).toBe("queued");
    await drain();
    const view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("completed");
    expect(view.steps.map((s) => [s.step_key, s.status, s.attempt_count])).toEqual([["a", "completed", 1], ["b", "completed", 1]]);
    expect(view.steps[0]!.output).toBe("secret output of a");
    expect(view.task.last_checkpoint_at).not.toBeNull();
    const [raw] = await db.system<{ result_secret: string }[]>`select result_secret from task_steps where task_id = ${task.id} and step_key = 'a'`;
    expect(raw!.result_secret.startsWith("enc:")).toBe(true);
    const ev = await engine.listEvents(actor("t_alice"), task.id, {});
    expect(ev.events.map((e) => e.event_type).reverse()).toEqual(["task.created", "step.started", "step.completed", "step.started", "step.completed", "task.completed"]);
    // Completed is final.
    await expect(engine.resume(actor("t_alice"), task.id)).rejects.toBeInstanceOf(TaskTransitionError);
    await expect(engine.cancel(actor("t_alice"), task.id)).rejects.toBeInstanceOf(TaskTransitionError);
  });

  it("returns the same task for a repeated idempotency key and rejects unknown types", async () => {
    const a = await engine.createTask(actor("t_alice"), { taskType: "two_steps", idempotencyKey: "same-key-123" });
    const b = await engine.createTask(actor("t_alice"), { taskType: "two_steps", idempotencyKey: "same-key-123" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
    // Another user may use the same key independently.
    const c = await engine.createTask(actor("t_bob"), { taskType: "two_steps", idempotencyKey: "same-key-123" });
    expect(c.task.id).not.toBe(a.task.id);
    await expect(engine.createTask(actor("t_alice"), { taskType: "nope" })).rejects.toMatchObject({ code: "invalid_input" });
    await engine.cancel(actor("t_alice"), a.task.id);
    await engine.cancel(actor("t_bob"), c.task.id);
  });

  it("isolates tasks, steps, events and approvals between users (RLS)", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "gated" });
    await drain();
    expect(await statusOf(task.id)).toBe("waiting_for_approval");
    const asBob = <T>(fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids.t_bob!, role: "CUSTOMER" }, fn);
    for (const table of ["tasks", "task_steps", "task_events", "approvals"]) {
      const rows = await asBob((tx) => tx.unsafe(`select id from ${table} where ${table === "tasks" ? "id" : "task_id"} = $1`, [task.id]));
      expect(rows, table).toHaveLength(0);
    }
    expect(await asBob((tx) => tx`update tasks set status = 'cancelled' where id = ${task.id} returning id`)).toHaveLength(0);
    expect(await asBob((tx) => tx`update task_steps set status = 'cancelled' where task_id = ${task.id} returning id`)).toHaveLength(0);
    expect(await asBob((tx) => tx`update approvals set status = 'approved', decided_at = now() where task_id = ${task.id} returning id`)).toHaveLength(0);
    // Bob cannot attach rows to Alice's task, neither as himself (FK on task_id + user_id) nor as Alice (RLS).
    await expect(asBob((tx) => tx`insert into task_steps (task_id, user_id, step_key, step_type, title, sequence_number) values (${task.id}, ${ids.t_bob!}, 'x', 'server.echo', 'x', 9)`)).rejects.toThrow(/foreign key/);
    await expect(asBob((tx) => tx`insert into task_steps (task_id, user_id, step_key, step_type, title, sequence_number) values (${task.id}, ${ids.t_alice!}, 'x', 'server.echo', 'x', 9)`)).rejects.toThrow(/row-level security/);
    await expect(asBob((tx) => tx`insert into task_events (task_id, user_id, event_type, message) values (${task.id}, ${ids.t_alice!}, 'x.y', 'x')`)).rejects.toThrow(/row-level security/);
    // The engine refuses too.
    await expect(engine.getTask(actor("t_bob"), task.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(engine.pause(actor("t_bob"), task.id)).rejects.toMatchObject({ code: "not_found" });
    const [ap] = await db.system<{ id: string }[]>`select id from approvals where task_id = ${task.id}`;
    await expect(engine.decideApproval(actor("t_bob"), ap!.id, "approve")).rejects.toMatchObject({ code: "not_found" });
    // Events are append-only and approvals cannot be created by the runtime role.
    await expect(withUser(db, { userId: ids.t_alice!, role: "CUSTOMER" }, (tx) => tx`update task_events set message = 'x' where task_id = ${task.id}`)).rejects.toThrow(/permission denied/);
    await expect(withUser(db, { userId: ids.t_alice!, role: "CUSTOMER" }, (tx) => tx`delete from task_events where task_id = ${task.id}`)).rejects.toThrow(/permission denied/);
    await expect(
      withUser(db, { userId: ids.t_alice!, role: "CUSTOMER" }, (tx) => tx`insert into approvals (task_id, user_id, step_id, action_type, action_summary, payload_hash, expires_at) select task_id, user_id, step_id, 'x.y', 'x', repeat('a', 64), now() from approvals where id = ${ap!.id}`),
    ).rejects.toThrow(/permission denied/);
    await engine.cancel(actor("t_alice"), task.id);
  });

  it("pause stops processing, also mid-step; resume continues; cancel is final", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "two_steps" });
    await engine.pause(actor("t_alice"), task.id);
    calls.length = 0;
    await drain();
    expect(calls).toHaveLength(0);
    await engine.resume(actor("t_alice"), task.id);
    // The user pauses while step A runs: A finishes, B does not start.
    duringStep = () => engine.pause(actor("t_alice"), task.id).then(() => undefined);
    await drain();
    duringStep = null;
    let view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("paused");
    expect(view.steps.map((s) => s.status)).toEqual(["completed", "pending"]);
    await engine.resume(actor("t_alice"), task.id);
    await drain();
    view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("completed");
    expect(calls).toHaveLength(2);

    const second = (await engine.createTask(actor("t_alice"), { taskType: "two_steps" })).task;
    await engine.cancel(actor("t_alice"), second.id);
    await drain();
    view = await engine.getTask(actor("t_alice"), second.id);
    expect(view.task.status).toBe("cancelled");
    expect(view.steps.every((s) => s.status === "cancelled")).toBe(true);
    await expect(engine.resume(actor("t_alice"), second.id)).rejects.toBeInstanceOf(TaskTransitionError);
    await expect(engine.pause(actor("t_alice"), second.id)).rejects.toBeInstanceOf(TaskTransitionError);
  });

  it("gives the lease back when the task is paused between claim and start, so resume runs at once", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "two_steps" });
    const claim = (await engine.claimNext("runner-x"))!;
    expect(claim.taskId).toBe(task.id);
    await engine.pause(actor("t_alice"), task.id);
    await engine.advance(claim);
    const [row] = await db.system<{ lease_token: string | null }[]>`select lease_token from tasks where id = ${task.id}`;
    expect(row!.lease_token).toBeNull();
    await engine.resume(actor("t_alice"), task.id);
    await drain();
    expect(await statusOf(task.id)).toBe("completed");
  });

  it("lets only one of two concurrent runners claim a task", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "two_steps" });
    const claims = await Promise.all([engine.claimNext("runner-1"), engine.claimNext("runner-2"), engine.claimNext("runner-3")]);
    const mine = claims.filter((c) => c?.taskId === task.id);
    expect(mine).toHaveLength(1);
    for (const c of claims) if (c) await engine.advance(c);
    await drain();
    expect(await statusOf(task.id)).toBe("completed");
  });

  it("recovers an expired lease: repeats a safe step, but parks a risky one for verification", async () => {
    const quick = make({ leaseMs: 40 });
    // Safe step: simulate a crash after the step started.
    const safe = (await quick.createTask(actor("t_alice"), { taskType: "two_steps" })).task;
    let claim = (await quick.claimNext("crashy"))!;
    await db.system`update task_steps set status = 'running', attempt_count = 1, started_at = now() where task_id = ${safe.id} and step_key = 'a'`;
    await sleep(80);
    // The crashed worker cannot report anymore.
    expect(await quick.recoverExpiredLeases()).toBeGreaterThanOrEqual(1);
    await quick.advance(claim); // stale claim: does nothing
    await drain(quick);
    let view = await quick.getTask(actor("t_alice"), safe.id);
    expect(view.task.status).toBe("completed");
    expect(view.steps[0]!.attempt_count).toBe(2);

    // Risky step: never repeated blindly.
    const risky = (await quick.createTask(actor("t_alice"), { taskType: "risky" })).task;
    claim = (await quick.claimNext("crashy"))!;
    expect(claim.taskId).toBe(risky.id);
    await db.system`update task_steps set status = 'running', attempt_count = 1, started_at = now() where task_id = ${risky.id}`;
    await sleep(80);
    calls.length = 0;
    await drain(quick);
    view = await quick.getTask(actor("t_alice"), risky.id);
    expect(view.task.status).toBe("paused");
    expect(view.steps[0]).toMatchObject({ status: "waiting", error_code: "needs_verification" });
    expect(calls).toHaveLength(0);
    await expect(quick.resume(actor("t_alice"), risky.id)).rejects.toMatchObject({ code: "needs_verification" });
    await expect(quick.retry(actor("t_alice"), risky.id)).rejects.toMatchObject({ code: "needs_verification" });
    await quick.retry(actor("t_alice"), risky.id, { confirmUncertain: true });
    await drain(quick);
    expect(await statusOf(risky.id)).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("fails safely, redacts error text, retries only failed steps and stops after the attempt limit", async () => {
    calls.length = 0;
    failNext = 1;
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "two_steps" });
    await drain();
    let view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("failed");
    expect(view.steps[0]).toMatchObject({ status: "failed", error_code: "step_failed" });
    expect(view.steps[0]!.error_message).not.toMatch(/hunter2|abc\.def/);
    await engine.retry(actor("t_alice"), task.id);
    await drain();
    view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("completed");
    expect(view.task.attempt_count).toBe(1);
    // Completed tasks cannot be retried.
    await expect(engine.retry(actor("t_alice"), task.id)).rejects.toMatchObject({ code: "retry_not_allowed" });

    failNext = 99;
    const stubborn = (await engine.createTask(actor("t_alice"), { taskType: "two_steps" })).task;
    await drain();
    await engine.retry(actor("t_alice"), stubborn.id);
    await drain();
    await engine.retry(actor("t_alice"), stubborn.id);
    await drain();
    await expect(engine.retry(actor("t_alice"), stubborn.id)).rejects.toMatchObject({ code: "retry_not_allowed" });
    failNext = 0;
    await engine.cancel(actor("t_alice"), stubborn.id);
  });

  it("gates an action behind a single-use approval bound to its payload", async () => {
    effects = 0;
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "gated" });
    await drain();
    const view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("waiting_for_approval");
    const ap = view.approvals[0]!;
    expect(ap).toMatchObject({ status: "pending", action_type: "test.write" });
    expect(effects).toBe(0);
    await engine.decideApproval(actor("t_alice"), ap.id, "approve");
    await drain();
    expect(await statusOf(task.id)).toBe("completed");
    expect(effects).toBe(1);
    const [used] = await db.system<{ consumed_at: Date | null }[]>`select consumed_at from approvals where id = ${ap.id}`;
    expect(used!.consumed_at).not.toBeNull();
    // Decisions are final and single-use, also at the database level.
    await expect(engine.decideApproval(actor("t_alice"), ap.id, "reject")).rejects.toMatchObject({ code: "approval_decided" });
    await expect(db.system`update approvals set status = 'rejected' where id = ${ap.id}`).rejects.toThrow(/already approved/);
    await expect(db.system`update approvals set consumed_at = now() where id = ${ap.id}`).rejects.toThrow(/already used/);
    await expect(db.system`update approvals set action_type = 'other.action' where id = ${ap.id}`).rejects.toThrow(/re-targeted/);

    // An approval no longer matching its action (payload changed) is not honoured.
    const second = (await engine.createTask(actor("t_alice"), { taskType: "gated" })).task;
    await drain();
    const ap2 = (await engine.getTask(actor("t_alice"), second.id)).approvals[0]!;
    await engine.decideApproval(actor("t_alice"), ap2.id, "approve");
    await db.system`update task_steps set result_secret = 'enc:changed after approval' where task_id = ${second.id} and step_key = 'a'`;
    await drain();
    const v2 = await engine.getTask(actor("t_alice"), second.id);
    expect(v2.task.status).toBe("failed");
    expect(v2.steps[1]).toMatchObject({ status: "failed", error_code: "approval_mismatch" });
    expect(effects).toBe(1);

    // Rejection stops the task.
    const third = (await engine.createTask(actor("t_alice"), { taskType: "gated" })).task;
    await drain();
    const ap3 = (await engine.getTask(actor("t_alice"), third.id)).approvals[0]!;
    await engine.decideApproval(actor("t_alice"), ap3.id, "reject");
    await drain();
    expect(await statusOf(third.id)).toBe("failed");
    expect(effects).toBe(1);
  });

  it("expires approvals; an expired approval can no longer be used, and retry asks again", async () => {
    const short = make({ approvalTtlMs: 30 });
    const { task } = await short.createTask(actor("t_alice"), { taskType: "gated" });
    await drain(short);
    const ap = (await short.getTask(actor("t_alice"), task.id)).approvals[0]!;
    await sleep(60);
    await expect(short.decideApproval(actor("t_alice"), ap.id, "approve")).rejects.toMatchObject({ code: "approval_expired" });
    expect(await statusOf(task.id)).toBe("failed");
    await expect(short.decideApproval(actor("t_alice"), ap.id, "approve")).rejects.toMatchObject({ code: "approval_decided" });
    await short.retry(actor("t_alice"), task.id);
    await drain(); // normal TTL engine asks again
    const view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("waiting_for_approval");
    expect(view.approvals.map((a) => a.status)).toEqual(["pending", "expired"]);
    await engine.cancel(actor("t_alice"), task.id);
    expect((await engine.getTask(actor("t_alice"), task.id)).approvals[0]!.status).toBe("expired");
  });

  it("hands browser steps to the owner's worker only, with a lease the worker must present", async () => {
    const { task } = await engine.createTask(actor("t_alice"), { taskType: "browser" });
    await drain();
    expect(await statusOf(task.id)).toBe("waiting_for_browser");
    expect(await engine.claimBrowserStep(actor("t_bob"), "bob-ext")).toBeNull();
    const claim = (await engine.claimBrowserStep(actor("t_alice"), "alice-ext"))!;
    expect(claim.step.status).toBe("running");
    expect(await engine.claimBrowserStep(actor("t_alice"), "alice-ext-2")).toBeNull();
    const wrong = "00000000-0000-4000-8000-000000000000";
    await expect(engine.reportStep(actor("t_alice"), task.id, claim.step.id, { leaseToken: wrong, outcome: "completed" })).rejects.toMatchObject({ code: "lease_lost" });
    await expect(engine.reportStep(actor("t_bob"), task.id, claim.step.id, { leaseToken: claim.leaseToken, outcome: "completed" })).rejects.toMatchObject({ code: "not_found" });
    await engine.saveCheckpoint(actor("t_alice"), task.id, claim.leaseToken, { fieldsRead: 12 });
    await engine.reportStep(actor("t_alice"), task.id, claim.step.id, { leaseToken: claim.leaseToken, outcome: "completed", result: { fields: 12 } });
    await drain();
    const view = await engine.getTask(actor("t_alice"), task.id);
    expect(view.task.status).toBe("completed");
    expect(view.task.checkpoint_json).toEqual({ fieldsRead: 12 });
    // The old lease is gone.
    await expect(engine.reportStep(actor("t_alice"), task.id, claim.step.id, { leaseToken: claim.leaseToken, outcome: "progress" })).rejects.toMatchObject({ code: "lease_lost" });

    // An uncertain browser outcome pauses the task for verification.
    const second = (await engine.createTask(actor("t_alice"), { taskType: "browser" })).task;
    await drain();
    const c2 = (await engine.claimBrowserStep(actor("t_alice"), "alice-ext"))!;
    await engine.reportStep(actor("t_alice"), second.id, c2.step.id, { leaseToken: c2.leaseToken, outcome: "uncertain", message: "Page reloaded during fill" });
    const v2 = await engine.getTask(actor("t_alice"), second.id);
    expect(v2.task.status).toBe("paused");
    expect(v2.steps[0]).toMatchObject({ status: "waiting", error_code: "needs_verification" });
    await engine.cancel(actor("t_alice"), second.id);
  });

  it("paginates the task list and filters by status", async () => {
    for (let i = 0; i < 3; i++) await engine.createTask(actor("t_bob"), { taskType: "browser", title: `B${i}` });
    const p1 = await engine.listTasks(actor("t_bob"), { limit: 2 });
    expect(p1.tasks).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await engine.listTasks(actor("t_bob"), { limit: 2, before: p1.next });
    expect(p2.tasks.map((t) => t.id)).not.toContain(p1.tasks[0]!.id);
    const queued = await engine.listTasks(actor("t_bob"), { status: "queued", limit: 50 });
    expect(queued.tasks.every((t) => t.status === "queued")).toBe(true);
    expect(p1.tasks[0]).not.toHaveProperty("lease_token");
    expect(TaskError).toBeDefined();
  });
});
