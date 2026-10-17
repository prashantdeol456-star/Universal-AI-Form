import { createHash, randomUUID } from "node:crypto";
import { withUser, type Db, type TransactionSql } from "@ufa/db";
import {
  assertStepTransition,
  assertTaskTransition,
  CANCELLABLE,
  DONE_STEP_STATUSES,
  PAUSABLE,
  TaskTransitionError,
  type StepStatus,
  type TaskStatus,
} from "@ufa/shared/tasks";
import {
  TaskError,
  type Actor,
  type ApprovalRow,
  type ApprovalSpec,
  type EventRow,
  type Json,
  type JsonObject,
  type ServerStepHandler,
  type StepContext,
  type StepRow,
  type TaskRow,
  type TaskTemplate,
} from "./types";

/**
 * Persistent task engine (AI browser Phase 1).
 *
 * Source of truth is PostgreSQL. User actions run as the user (RLS); the in-process runner
 * uses the owner pool and claims one task at a time with a lease (FOR UPDATE SKIP LOCKED),
 * so two runners never work on the same task. After every step the result is committed
 * (the checkpoint). When a lease expires mid-step, an idempotent step is simply run again;
 * any other step is parked as "needs verification" and the task paused, so nothing with a
 * possible side effect is repeated without the user confirming it did not happen.
 */
export interface EngineOptions {
  db: Db;
  templates: Record<string, TaskTemplate>;
  serverHandlers: Record<string, ServerStepHandler>;
  approvals: Record<string, ApprovalSpec>;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  leaseMs?: number;
  approvalTtlMs?: number;
  maxStepAttempts?: number;
}

export interface Claim {
  taskId: string;
  userId: string;
  token: string;
}

export interface TaskView {
  task: Omit<TaskRow, "lease_token" | "lease_owner">;
  steps: Array<Omit<StepRow, "result_secret"> & { output: string | null }>;
  approvals: ApprovalRow[];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable JSON (sorted keys) so the same payload always hashes the same. */
function stable(v: Json): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as JsonObject)[k]!)}`)
    .join(",")}}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Error text shown to the user and kept in the row: short, and stripped of anything that looks like a secret. */
const safeMessage = (err: unknown) =>
  clip(
    (err instanceof Error ? err.message : String(err))
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(password|token|otp|secret|cookie)\b\s*[:=]\s*\S+/gi, "$1=[redacted]"),
    300,
  );

export function createTaskEngine(opts: EngineOptions) {
  const { db } = opts;
  const leaseMs = opts.leaseMs ?? 120_000;
  const approvalTtlMs = opts.approvalTtlMs ?? 7 * 24 * 3600_000;
  const maxAttempts = opts.maxStepAttempts ?? 3;
  const asUser = <T>(actor: Actor, fn: (tx: TransactionSql) => Promise<T>) => withUser(db, { userId: actor.id, role: actor.role }, fn);

  async function event(tx: TransactionSql, t: { id: string; user_id: string }, type: string, message: string, metadata: JsonObject = {}, stepId: string | null = null) {
    await tx`insert into task_events (task_id, user_id, step_id, event_type, message, metadata_json)
             values (${t.id}, ${t.user_id}, ${stepId}, ${type}, ${clip(message, 500)}, ${tx.json(metadata)})`;
  }

  async function setTask(tx: TransactionSql, task: TaskRow, to: TaskStatus, extra: { error_code?: string | null; error_message?: string | null } = {}) {
    assertTaskTransition(task.status, to);
    const rows = await tx<TaskRow[]>`
      update tasks set status = ${to},
        error_code = ${extra.error_code === undefined ? task.error_code : extra.error_code},
        error_message = ${extra.error_message === undefined ? task.error_message : extra.error_message},
        completed_at = case when ${to} = 'completed' then now() else completed_at end,
        cancelled_at = case when ${to} = 'cancelled' then now() else cancelled_at end
       where id = ${task.id} and status = ${task.status} returning *`;
    if (!rows.length) throw new TaskTransitionError("task", task.status, to);
    return rows[0]!;
  }

  async function setStep(tx: TransactionSql, step: StepRow, to: StepStatus, extra: Partial<Pick<StepRow, "error_code" | "error_message" | "result_json" | "result_secret">> = {}) {
    assertStepTransition(step.status, to);
    const resultJson = extra.result_json === undefined ? step.result_json : extra.result_json;
    const rows = await tx<StepRow[]>`
      update task_steps set status = ${to},
        error_code = ${extra.error_code === undefined ? step.error_code : extra.error_code},
        error_message = ${extra.error_message === undefined ? step.error_message : extra.error_message},
        result_json = ${resultJson === null ? null : tx.json(resultJson)},
        result_secret = ${extra.result_secret === undefined ? step.result_secret : extra.result_secret},
        attempt_count = case when ${to} = 'running' then attempt_count + 1 else attempt_count end,
        started_at = case when ${to} = 'running' then now() else started_at end,
        completed_at = case when ${to} in ('completed', 'skipped') then now() else completed_at end
       where id = ${step.id} and status = ${step.status} returning *`;
    if (!rows.length) throw new TaskTransitionError("step", step.status, to);
    return rows[0]!;
  }

  const lockTask = async (tx: TransactionSql, id: string) => {
    const [t] = await tx<TaskRow[]>`select * from tasks where id = ${id} for update`;
    if (!t) throw new TaskError("not_found", "Task not found");
    return t;
  };
  const stepsOf = (tx: TransactionSql, taskId: string) => tx<StepRow[]>`select * from task_steps where task_id = ${taskId} order by sequence_number`;
  const nextStep = (steps: StepRow[]) => steps.find((s) => !DONE_STEP_STATUSES.includes(s.status));

  function contextFor(task: TaskRow, step: StepRow, steps: StepRow[], role: string): StepContext {
    const previous: StepContext["previous"] = {};
    for (const s of steps) {
      if (s.status !== "completed") continue;
      previous[s.step_key] = { result: s.result_json, secret: s.result_secret ? opts.decrypt(s.result_secret) : null };
    }
    return { userId: task.user_id, role, taskId: task.id, stepId: step.id, stepKey: step.step_key, taskInput: task.input_json, stepInput: step.input_json, previous };
  }

  async function releaseLease(tx: TransactionSql, taskId: string, token: string) {
    await tx`update tasks set lease_owner = null, lease_token = null, lease_expires_at = null where id = ${taskId} and lease_token = ${token}`;
  }

  // ------------------------------------------------------------------ user operations

  async function createTask(
    actor: Actor,
    input: { taskType: string; title?: string | null; description?: string | null; input?: unknown; priority?: number; idempotencyKey?: string | null },
  ): Promise<{ task: TaskRow; created: boolean }> {
    const template = opts.templates[input.taskType];
    if (!template) throw new TaskError("invalid_input", `Unknown task type "${input.taskType}"`);
    const parsed = template.parse(input.input ?? {});
    const steps = template.steps(parsed);
    if (!steps.length) throw new TaskError("invalid_input", "This task has nothing to do");
    for (const s of steps) {
      if (s.type.startsWith("server.") && !opts.serverHandlers[s.type]) throw new TaskError("invalid_input", `No handler for step ${s.type}`);
      if (s.type.startsWith("approval.") && !opts.approvals[s.type]) throw new TaskError("invalid_input", `No approval rule for step ${s.type}`);
    }
    return asUser(actor, async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx<TaskRow[]>`select * from tasks where user_id = ${actor.id} and idempotency_key = ${input.idempotencyKey}`;
        if (existing) return { task: existing, created: false };
      }
      const [task] = await tx<TaskRow[]>`
        insert into tasks (user_id, title, description, task_type, priority, input_json, idempotency_key)
        values (${actor.id}, ${clip(input.title?.trim() || template.defaultTitle(parsed), 200)}, ${input.description?.trim() || null},
                ${input.taskType}, ${input.priority ?? 0}, ${tx.json(parsed)}, ${input.idempotencyKey ?? null})
        returning *`;
      let n = 0;
      for (const s of steps) {
        const idempotent = s.idempotent ?? !(s.type.startsWith("browser.") || s.type.startsWith("local."));
        await tx`insert into task_steps (task_id, user_id, step_key, step_type, title, idempotent, input_json, sequence_number)
                 values (${task!.id}, ${actor.id}, ${s.key}, ${s.type}, ${clip(s.title, 200)}, ${idempotent}, ${tx.json(s.input ?? {})}, ${s.sequence ?? n})`;
        n++;
      }
      await event(tx, task!, "task.created", `Task created with ${steps.length} step${steps.length === 1 ? "" : "s"}`, { type: input.taskType });
      return { task: task!, created: true };
    });
  }

  async function listTasks(actor: Actor, q: { status?: TaskStatus | null; limit?: number; before?: { createdAt: string; id: string } | null }) {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    return asUser(actor, async (tx) => {
      const rows = await tx<Array<TaskRow & { steps_total: number; steps_done: number }>>`
        select t.*, (select count(*)::int from task_steps s where s.task_id = t.id) as steps_total,
               (select count(*)::int from task_steps s where s.task_id = t.id and s.status in ('completed', 'skipped')) as steps_done
          from tasks t
         where t.user_id = ${actor.id}
           ${q.status ? tx`and t.status = ${q.status}` : tx``}
           ${q.before ? tx`and (t.created_at, t.id) < (${q.before.createdAt}::timestamptz, ${q.before.id}::uuid)` : tx``}
         order by t.created_at desc, t.id desc
         limit ${limit + 1}`;
      const page = rows.slice(0, limit).map(({ lease_token: _t, lease_owner: _o, ...r }) => r);
      const last = page.at(-1);
      return { tasks: page, next: rows.length > limit && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null };
    });
  }

  async function getTask(actor: Actor, id: string): Promise<TaskView> {
    return asUser(actor, async (tx) => {
      const [task] = await tx<TaskRow[]>`select * from tasks where id = ${id}`;
      if (!task) throw new TaskError("not_found", "Task not found");
      const steps = await stepsOf(tx, id);
      const approvals = await tx<ApprovalRow[]>`select * from approvals where task_id = ${id} order by created_at desc limit 20`;
      const { lease_token: _t, lease_owner: _o, ...t } = task;
      return {
        task: t,
        steps: steps.map(({ result_secret, ...s }) => ({ ...s, output: result_secret ? opts.decrypt(result_secret) : null })),
        approvals,
      };
    });
  }

  async function listEvents(actor: Actor, id: string, q: { limit?: number; beforeId?: string | null }) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    return asUser(actor, async (tx) => {
      const [t] = await tx`select id from tasks where id = ${id}`;
      if (!t) throw new TaskError("not_found", "Task not found");
      const rows = await tx<EventRow[]>`
        select id::text, task_id, step_id, event_type, message, metadata_json, created_at from task_events
         where task_id = ${id} ${q.beforeId ? tx`and id < ${q.beforeId}::bigint` : tx``}
         order by id desc limit ${limit + 1}`;
      return { events: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  }

  async function pause(actor: Actor, id: string) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, id);
      if (!PAUSABLE.includes(task.status)) throw new TaskTransitionError("task", task.status, "paused");
      const t = await setTask(tx, task, "paused");
      await event(tx, t, "task.paused", "Paused by you");
      return t;
    });
  }

  async function resume(actor: Actor, id: string) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, id);
      const steps = await stepsOf(tx, id);
      if (steps.some((s) => s.error_code === "needs_verification" && s.status === "waiting")) {
        throw new TaskError("needs_verification", "A step may or may not have happened. Check it, then use Retry and confirm.");
      }
      const t = await setTask(tx, task, "queued");
      await event(tx, t, "task.resumed", "Resumed by you");
      return t;
    });
  }

  async function cancel(actor: Actor, id: string) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, id);
      if (!CANCELLABLE.includes(task.status)) throw new TaskTransitionError("task", task.status, "cancelled");
      const t = await setTask(tx, task, "cancelled");
      await tx`update tasks set lease_owner = null, lease_token = null, lease_expires_at = null where id = ${id}`;
      await tx`update task_steps set status = 'cancelled' where task_id = ${id} and status not in ('completed', 'skipped', 'cancelled')`;
      await tx`update approvals set status = 'expired' where task_id = ${id} and status = 'pending'`;
      await event(tx, t, "task.cancelled", "Cancelled by you");
      return t;
    });
  }

  /**
   * Retry after a failure, or after the user checked a step whose outcome was uncertain.
   * Completed steps are never run again. An uncertain step needs confirmUncertain=true.
   */
  async function retry(actor: Actor, id: string, input: { stepId?: string | null; confirmUncertain?: boolean } = {}) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, id);
      if (task.status !== "failed" && task.status !== "paused") throw new TaskError("retry_not_allowed", `A ${task.status} task cannot be retried`);
      const steps = await stepsOf(tx, id);
      const step = input.stepId
        ? steps.find((s) => s.id === input.stepId)
        : steps.find((s) => s.status === "failed" || (s.status === "waiting" && s.error_code === "needs_verification"));
      if (!step) throw new TaskError("retry_not_allowed", "There is no failed step to retry");
      const uncertain = step.status === "waiting" && step.error_code === "needs_verification";
      if (step.status !== "failed" && !uncertain) throw new TaskError("retry_not_allowed", `A ${step.status} step cannot be retried`);
      if (uncertain && !input.confirmUncertain) {
        throw new TaskError("needs_verification", "Confirm that you checked this step did not happen before it runs again");
      }
      if (step.attempt_count >= maxAttempts) throw new TaskError("retry_not_allowed", `This step already ran ${step.attempt_count} times`);
      await setStep(tx, step, "pending", { error_code: null, error_message: null });
      const t = await setTask(tx, task, "queued", { error_code: null, error_message: null });
      await tx`update tasks set attempt_count = attempt_count + 1 where id = ${id}`;
      await event(tx, t, "task.retried", uncertain ? `Retrying "${step.title}" after you confirmed it did not happen` : `Retrying "${step.title}"`, {}, step.id);
      return t;
    });
  }

  async function decideApproval(actor: Actor, approvalId: string, decision: "approve" | "reject", note?: string | null) {
    // Expiry is recorded (committed) first, then reported as an error: throwing inside the transaction would roll it back.
    const outcome = await asUser(actor, async (tx): Promise<ApprovalRow | "expired"> => {
      const [a] = await tx<ApprovalRow[]>`select * from approvals where id = ${approvalId} for update`;
      if (!a) throw new TaskError("not_found", "Approval not found");
      const task = await lockTask(tx, a.task_id);
      if (a.status !== "pending") throw new TaskError("approval_decided", `This request was already ${a.status}`);
      const [step] = await tx<StepRow[]>`select * from task_steps where id = ${a.step_id} for update`;
      if (a.expires_at.getTime() <= Date.now()) {
        await tx`update approvals set status = 'expired' where id = ${a.id}`;
        if (step && step.status === "waiting") await setStep(tx, step, "failed", { error_code: "approval_expired", error_message: "The approval request expired" });
        if (task.status === "waiting_for_approval") await setTask(tx, task, "failed", { error_code: "approval_expired", error_message: "The approval request expired" });
        await event(tx, task, "approval.expired", `Approval for "${a.action_summary}" expired`, {}, a.step_id);
        return "expired";
      }
      const decisionPayload = { decision, ...(note ? { note: clip(note, 300) } : {}) };
      await tx`update approvals set status = ${decision === "approve" ? "approved" : "rejected"}, decided_at = now(), decision_payload_json = ${tx.json(decisionPayload)} where id = ${a.id}`;
      if (decision === "approve") {
        // The runner carries out the approved action once; a paused task stays paused until resumed.
        if (task.status === "waiting_for_approval") await setTask(tx, task, "queued");
        await event(tx, task, "approval.approved", `You approved: ${a.action_summary}`, {}, a.step_id);
      } else {
        if (step && step.status === "waiting") await setStep(tx, step, "failed", { error_code: "rejected", error_message: "You rejected this step" });
        if (task.status === "waiting_for_approval" || task.status === "paused") {
          await setTask(tx, { ...task, status: task.status }, task.status === "paused" ? "cancelled" : "failed", { error_code: "rejected", error_message: "You rejected a step" });
        }
        await event(tx, task, "approval.rejected", `You rejected: ${a.action_summary}`, {}, a.step_id);
      }
      const [updated] = await tx<ApprovalRow[]>`select * from approvals where id = ${a.id}`;
      return updated!;
    });
    if (outcome === "expired") throw new TaskError("approval_expired", "This approval request has expired. Retry the task to ask again.");
    return outcome;
  }

  /**
   * Multi-page forms: the user moved to the next page themselves (the assistant never clicks
   * Next) and asks to continue. Adds that page's steps before the final step; the template
   * refuses pages on another site. Only while the task waits for the final review.
   */
  async function addPage(actor: Actor, id: string, url: string) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, id);
      const template = opts.templates[task.task_type];
      if (!template?.nextPage) throw new TaskError("invalid_input", "This task has no pages");
      if (task.status !== "waiting_for_approval") throw new TaskError("invalid_input", "Finish the current page before adding the next one");
      const steps = await stepsOf(tx, id);
      const pageNumber = steps.filter((s) => s.step_type.startsWith("browser.") && s.step_key.startsWith("read_")).length + 1;
      if (pageNumber > 50) throw new TaskError("invalid_input", "A task can have at most 50 pages");
      const added = template.nextPage(task.input_json, pageNumber, url);
      for (const s of added) {
        if (!s.type.startsWith("browser.")) throw new TaskError("invalid_input", "Pages can only add browser steps");
        await tx`insert into task_steps (task_id, user_id, step_key, step_type, title, idempotent, input_json, sequence_number)
                 values (${id}, ${task.user_id}, ${s.key}, ${s.type}, ${clip(s.title, 200)}, ${s.idempotent ?? false}, ${tx.json(s.input ?? {})}, ${s.sequence ?? 900 + pageNumber})`;
      }
      // The final review must be asked again after the new page, so the open request lapses.
      const waiting = steps.filter((s) => s.step_type.startsWith("approval.") && s.status === "waiting");
      await tx`update approvals set status = 'expired' where task_id = ${id} and status = 'pending'`;
      for (const s of waiting) await setStep(tx, s, "pending");
      const t = await setTask(tx, task, "queued");
      await event(tx, t, "task.page_added", `Continuing on page ${pageNumber}`, { page: pageNumber });
      return t;
    });
  }

  // ------------------------------------------------------------------ browser worker (the user's extension)

  /** The user's extension claims its next browser step. Only the caller's own tasks are visible (RLS). */
  async function claimBrowserStep(actor: Actor, workerId: string, taskId?: string | null) {
    return claimExternalStep(actor, workerId, "browser.", taskId);
  }

  /**
   * An external worker (the extension for "browser." steps, a paired local companion for "local."
   * steps) claims the next step of that kind in one of the caller's own tasks. `accept` lets the
   * caller restrict which tasks it may take (a companion takes only tasks addressed to its device).
   */
  async function claimExternalStep(actor: Actor, workerId: string, prefix: "browser." | "local.", taskId?: string | null, accept?: (task: TaskRow) => boolean) {
    return asUser(actor, async (tx) => {
      // A worker acting on one page claims that page's task only.
      const candidates = await tx<TaskRow[]>`
        select * from tasks where user_id = ${actor.id} and status = 'waiting_for_browser' ${taskId ? tx`and id = ${taskId}` : tx``}
         order by priority desc, created_at for update skip locked limit 20`;
      let task: TaskRow | undefined;
      let step: StepRow | undefined;
      let all: StepRow[] = [];
      for (const t of candidates) {
        if (accept && !accept(t)) continue;
        all = await stepsOf(tx, t.id);
        const s = nextStep(all);
        if (s && s.step_type.startsWith(prefix) && s.status === "pending") {
          task = t;
          step = s;
          break;
        }
      }
      if (!task || !step) return null;
      // Non-secret results of the finished steps (e.g. the approved plan); encrypted outputs stay on the server.
      const previous: Record<string, JsonObject | null> = {};
      for (const s of all) if (s.status === "completed") previous[s.step_key] = (s.result_json as JsonObject | null) ?? null;
      const token = randomUUID();
      const running = await setStep(tx, step, "running");
      const t = await setTask(tx, task, "running");
      await tx`update tasks set lease_owner = ${clip(workerId, 100)}, lease_token = ${token}, lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval,
                 started_at = coalesce(started_at, now()) where id = ${t.id}`;
      await event(tx, t, "step.started", `Started "${step.title}" ${prefix === "local." ? "on your computer" : "in your browser"}`, {}, step.id);
      return { task: { id: t.id, title: t.title, task_type: t.task_type, input_json: t.input_json, checkpoint_json: t.checkpoint_json }, step: running, leaseToken: token, previous };
    });
  }

  /** Progress or outcome of a browser step, from the worker that holds the lease. */
  async function reportStep(
    actor: Actor,
    taskId: string,
    stepId: string,
    report: { leaseToken: string; outcome: "progress" | "completed" | "failed" | "uncertain"; message?: string | null; result?: JsonObject | null; checkpoint?: JsonObject | null; secret?: string | null },
  ) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task.lease_token !== report.leaseToken || !task.lease_expires_at || task.lease_expires_at.getTime() <= Date.now()) {
        throw new TaskError("lease_lost", "This worker no longer holds the task");
      }
      const [step] = await tx<StepRow[]>`select * from task_steps where id = ${stepId} and task_id = ${taskId} for update`;
      if (!step || step.status !== "running") throw new TaskError("lease_lost", "The step is not running");
      if (report.checkpoint) await tx`update tasks set checkpoint_json = ${tx.json(report.checkpoint)}, last_checkpoint_at = now() where id = ${taskId}`;
      const msg = report.message ? clip(report.message, 300) : null;
      if (report.outcome === "progress") {
        await tx`update tasks set lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval where id = ${taskId}`;
        if (msg) await event(tx, task, "step.progress", msg, {}, step.id);
        return { ok: true as const };
      }
      if (report.outcome === "completed") {
        // Personal output of a worker step (e.g. a summary of local files) is stored encrypted.
        await setStep(tx, step, "completed", { result_json: report.result ?? null, result_secret: report.secret ? opts.encrypt(report.secret) : null });
        if (task.status === "running") await setTask(tx, task, "queued");
        await event(tx, task, "step.completed", msg ?? `Finished "${step.title}"`, {}, step.id);
      } else if (report.outcome === "failed") {
        await setStep(tx, step, "failed", { error_code: "step_failed", error_message: msg });
        if (task.status === "running") await setTask(tx, task, "failed", { error_code: "step_failed", error_message: msg });
        await event(tx, task, "step.failed", msg ?? `"${step.title}" failed`, {}, step.id);
      } else {
        await setStep(tx, step, "waiting", { error_code: "needs_verification", error_message: msg ?? "The result could not be confirmed" });
        if (task.status === "running") await setTask(tx, task, "paused", { error_code: "needs_verification", error_message: "Check the page, then retry or cancel" });
        await event(tx, task, "step.uncertain", `Could not confirm "${step.title}". Check it before retrying.`, {}, step.id);
      }
      await releaseLease(tx, taskId, report.leaseToken);
      return { ok: true as const };
    });
  }

  async function saveCheckpoint(actor: Actor, taskId: string, leaseToken: string, data: JsonObject) {
    return asUser(actor, async (tx) => {
      const task = await lockTask(tx, taskId);
      if (task.lease_token !== leaseToken || !task.lease_expires_at || task.lease_expires_at.getTime() <= Date.now()) {
        throw new TaskError("lease_lost", "This worker no longer holds the task");
      }
      await tx`update tasks set checkpoint_json = ${tx.json(data)}, last_checkpoint_at = now() where id = ${taskId}`;
      return { ok: true as const };
    });
  }

  // ------------------------------------------------------------------ server runner (owner pool)

  /** Expired leases go back to the queue; the step decides what recovery means (see advance). */
  async function recoverExpiredLeases(): Promise<number> {
    return db.system.begin(async (tx) => {
      const rows = await tx<TaskRow[]>`
        update tasks set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null
         where status = 'running' and lease_expires_at < now() returning *`;
      for (const t of rows) await event(tx, t, "task.lease_expired", "The worker stopped responding; the task was put back in the queue");
      return rows.length;
    });
  }

  /** Pending approvals past their deadline expire; their tasks fail and can be retried. */
  async function expireApprovals(): Promise<number> {
    return db.system.begin(async (tx) => {
      const rows = await tx<ApprovalRow[]>`update approvals set status = 'expired' where status = 'pending' and expires_at <= now() returning *`;
      for (const a of rows) {
        const [step] = await tx<StepRow[]>`select * from task_steps where id = ${a.step_id} for update`;
        if (step?.status === "waiting") await setStep(tx, step, "failed", { error_code: "approval_expired", error_message: "The approval request expired" });
        const task = await lockTask(tx, a.task_id);
        if (task.status === "waiting_for_approval") await setTask(tx, task, "failed", { error_code: "approval_expired", error_message: "The approval request expired" });
        await event(tx, task, "approval.expired", `Approval for "${a.action_summary}" expired`, {}, a.step_id);
      }
      return rows.length;
    });
  }

  async function claimNext(workerId: string): Promise<Claim | null> {
    return db.system.begin(async (tx) => {
      const [task] = await tx<TaskRow[]>`
        select * from tasks where status = 'queued' and (lease_expires_at is null or lease_expires_at < now())
         order by priority desc, created_at for update skip locked limit 1`;
      if (!task) return null;
      const token = randomUUID();
      await setTask(tx, task, "running");
      await tx`update tasks set lease_owner = ${clip(workerId, 100)}, lease_token = ${token}, lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval,
                 started_at = coalesce(started_at, now()) where id = ${task.id}`;
      return { taskId: task.id, userId: task.user_id, token };
    });
  }

  const roleOf = async (userId: string) => {
    const [u] = await db.system<{ role: string }[]>`select role from users where id = ${userId}`;
    return u?.role ?? "CUSTOMER";
  };

  /** One step of progress for a claimed task. Always releases the lease before returning. */
  async function advance(claim: Claim): Promise<void> {
    type Plan =
      | { kind: "done" }
      | { kind: "run"; task: TaskRow; step: StepRow; steps: StepRow[] }
      | { kind: "approve"; task: TaskRow; step: StepRow; steps: StepRow[]; approval: ApprovalRow }
      | { kind: "ask"; task: TaskRow; step: StepRow; steps: StepRow[] };

    const plan: Plan = await db.system.begin(async (tx) => {
      const task = await lockTask(tx, claim.taskId);
      if (task.lease_token !== claim.token) return { kind: "done" } as const;
      // Paused or cancelled between claim and start: give the lease back so a resume is picked up at once.
      if (task.status !== "running") {
        await releaseLease(tx, task.id, claim.token);
        return { kind: "done" } as const;
      }
      const steps = await stepsOf(tx, task.id);
      const step = nextStep(steps);
      if (!step) {
        const t = await setTask(tx, task, "completed", { error_code: null, error_message: null });
        await tx`update tasks set result_json = ${tx.json({ steps: steps.length })} where id = ${t.id}`;
        await event(tx, t, "task.completed", "All steps finished");
        await releaseLease(tx, task.id, claim.token);
        return { kind: "done" } as const;
      }
      if (step.status === "failed") {
        await setTask(tx, task, "failed", { error_code: step.error_code ?? "step_failed", error_message: step.error_message });
        await releaseLease(tx, task.id, claim.token);
        return { kind: "done" } as const;
      }
      if (step.status === "running") {
        // A previous worker stopped mid-step.
        if (step.idempotent) {
          await setStep(tx, step, "pending");
          await event(tx, task, "step.recovered", `"${step.title}" will run again (safe to repeat)`, {}, step.id);
          step.status = "pending";
        } else {
          await setStep(tx, step, "waiting", { error_code: "needs_verification", error_message: "Interrupted; it may or may not have happened" });
          await setTask(tx, task, "paused", { error_code: "needs_verification", error_message: "Check the page, then retry or cancel" });
          await event(tx, task, "step.uncertain", `"${step.title}" was interrupted. Check it before retrying.`, {}, step.id);
          await releaseLease(tx, task.id, claim.token);
          return { kind: "done" } as const;
        }
      }
      if (step.step_type.startsWith("browser.") || step.step_type.startsWith("local.")) {
        if (step.status === "pending") {
          // Same waiting state for both kinds of external worker (browser extension, local companion).
          await setTask(tx, task, "waiting_for_browser");
          await event(tx, task, "task.waiting_for_browser", `"${step.title}" needs your ${step.step_type.startsWith("local.") ? "computer (local companion)" : "browser"}`, {}, step.id);
        }
        await releaseLease(tx, task.id, claim.token);
        return { kind: "done" } as const;
      }
      if (step.step_type.startsWith("approval.")) {
        const [approval] = await tx<ApprovalRow[]>`select * from approvals where step_id = ${step.id} order by created_at desc limit 1`;
        if (step.status === "waiting" && approval?.status === "approved") return { kind: "approve", task, step, steps, approval };
        if (step.status === "waiting" && approval?.status === "pending") {
          await setTask(tx, task, "waiting_for_approval");
          await releaseLease(tx, task.id, claim.token);
          return { kind: "done" } as const;
        }
        return { kind: "ask", task, step, steps };
      }
      const running = await setStep(tx, step, "running");
      await event(tx, task, "step.started", `Started "${step.title}"`, {}, step.id);
      return { kind: "run", task, step: running, steps };
    });
    if (plan.kind === "done") return;

    const role = await roleOf(plan.task.user_id);
    const ctx = contextFor(plan.task, plan.step, plan.steps, role);

    if (plan.kind === "ask") {
      const spec = opts.approvals[plan.step.step_type];
      await db.system.begin(async (tx) => {
        const task = await lockTask(tx, claim.taskId);
        if (task.lease_token !== claim.token) return;
        const [step] = await tx<StepRow[]>`select * from task_steps where id = ${plan.step.id} for update`;
        if (!spec) {
          await setStep(tx, step!, "failed", { error_code: "no_approval_rule", error_message: "This step cannot be approved" });
          await setTask(tx, task, "failed", { error_code: "no_approval_rule", error_message: "This step cannot be approved" });
        } else {
          const payload = spec.payload(ctx);
          const hash = sha256(stable({ step: plan.step.id, action: spec.actionType, payload }));
          await tx`insert into approvals (task_id, user_id, step_id, action_type, action_summary, requested_payload_json, payload_hash, expires_at)
                   values (${task.id}, ${task.user_id}, ${step!.id}, ${spec.actionType}, ${clip(spec.summary(ctx), 300)}, ${tx.json(payload)}, ${hash},
                           now() + ${`${approvalTtlMs} milliseconds`}::interval)`;
          await setStep(tx, step!, "waiting");
          if (task.status === "running") await setTask(tx, task, "waiting_for_approval");
          await event(tx, task, "approval.requested", `Waiting for your approval: ${clip(spec.summary(ctx), 200)}`, {}, step!.id);
        }
        await releaseLease(tx, task.id, claim.token);
      });
      return;
    }

    if (plan.kind === "approve") {
      const spec = opts.approvals[plan.step.step_type];
      const expected = spec ? sha256(stable({ step: plan.step.id, action: spec.actionType, payload: spec.payload(ctx) })) : null;
      const mismatch = !spec || plan.approval.action_type !== spec.actionType || plan.approval.payload_hash !== expected;
      let effectResult: JsonObject | void = undefined;
      if (!mismatch && !plan.approval.consumed_at) {
        // The effect and the consumption commit together: the action happens at most once per approval.
        effectResult = await withUser(db, { userId: plan.task.user_id, role }, async (tx) => {
          const used = await tx`update approvals set consumed_at = now() where id = ${plan.approval.id} and status = 'approved' and consumed_at is null returning id`;
          if (!used.length) return undefined;
          return spec!.effect ? spec!.effect(ctx, tx) : undefined;
        });
      }
      await db.system.begin(async (tx) => {
        const task = await lockTask(tx, claim.taskId);
        const [step] = await tx<StepRow[]>`select * from task_steps where id = ${plan.step.id} for update`;
        if (step && step.status === "waiting") {
          if (mismatch) {
            await setStep(tx, step, "failed", { error_code: "approval_mismatch", error_message: "The approval does not match this action" });
            if (task.status === "running") await setTask(tx, task, "failed", { error_code: "approval_mismatch", error_message: "The approval does not match this action" });
          } else {
            await setStep(tx, step, "completed", { result_json: { approved: true, ...(effectResult ?? {}) } });
            await tx`update tasks set last_checkpoint_at = now() where id = ${task.id}`;
            if (task.status === "running") await setTask(tx, task, "queued");
            await event(tx, task, "step.completed", `Approved and done: "${step.title}"`, {}, step.id);
          }
        }
        await releaseLease(tx, task.id, claim.token);
      });
      return;
    }

    // Server step.
    const handler = opts.serverHandlers[plan.step.step_type];
    let output: Awaited<ReturnType<ServerStepHandler>> | null = null;
    let failure: unknown = null;
    try {
      if (!handler) throw new Error(`No handler for ${plan.step.step_type}`);
      output = await handler(ctx);
    } catch (err) {
      failure = err;
    }
    await db.system.begin(async (tx) => {
      const task = await lockTask(tx, claim.taskId);
      const [step] = await tx<StepRow[]>`select * from task_steps where id = ${plan.step.id} for update`;
      // Cancelled meanwhile: the step is already "cancelled" and its result is discarded.
      if (step && step.status === "running") {
        if (failure) {
          const message = safeMessage(failure);
          await setStep(tx, step, "failed", { error_code: "step_failed", error_message: message });
          if (task.status === "running") await setTask(tx, task, "failed", { error_code: "step_failed", error_message: message });
          await event(tx, task, "step.failed", `"${step.title}" failed: ${message}`, {}, step.id);
        } else {
          await setStep(tx, step, "completed", {
            result_json: output?.result ?? {},
            result_secret: output?.secret ? opts.encrypt(output.secret) : null,
          });
          await tx`update tasks set last_checkpoint_at = now() where id = ${task.id}`;
          // A pause that arrived during the step is kept: the task does not continue.
          if (task.status === "running") await setTask(tx, task, "queued");
          await event(tx, task, "step.completed", output?.message ? clip(output.message, 300) : `Finished "${step.title}"`, {}, step.id);
        }
      }
      await releaseLease(tx, task.id, claim.token);
    });
  }

  /** Runner tick: recover, expire, then work through queued tasks (bounded). */
  async function runOnce(workerId: string, maxTasks = 20): Promise<number> {
    await recoverExpiredLeases();
    await expireApprovals();
    let n = 0;
    for (; n < maxTasks; n++) {
      const claim = await claimNext(workerId);
      if (!claim) break;
      await advance(claim);
    }
    return n;
  }

  return {
    createTask,
    listTasks,
    getTask,
    listEvents,
    pause,
    resume,
    cancel,
    retry,
    decideApproval,
    addPage,
    claimBrowserStep,
    claimExternalStep,
    reportStep,
    saveCheckpoint,
    recoverExpiredLeases,
    expireApprovals,
    claimNext,
    advance,
    runOnce,
  };
}

export type TaskEngine = ReturnType<typeof createTaskEngine>;
