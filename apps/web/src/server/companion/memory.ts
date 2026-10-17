import "server-only";
import { CAPABILITIES, LOCAL_STEPS, LOCAL_TASK_STEPS, LOCAL_TASK_TYPES, type Capability, type LocalTaskType } from "@ufa/local-agent";
import type { JsonObject } from "@ufa/tasks";
import { audit } from "../audit";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { createLocalTask } from "./planner";

/**
 * Workflow memory and feedback (AI browser Phase 6). Nothing here trains a model: workflows are
 * saved task recipes (task type + ids/options), preferences are a few known settings, feedback
 * is stored text. All of it is per user, visible on the Memory page, editable and deletable.
 * A learned workflow starts as a draft and must be approved before it can be run; running it
 * creates a normal task whose approval steps are never skipped, however often it succeeded.
 */
export const PREFERENCE_KEYS = {
  report_format: { label: "Report file format", values: ["csv", "md"] },
  organize_by: { label: "Organise files by", values: ["type", "extension", "month"] },
  summary_length: { label: "Summary length", values: ["short", "detailed"] },
  output_folder_id: { label: "Folder for new reports", values: null },
} as const;
export type PreferenceKey = keyof typeof PREFERENCE_KEYS;

export async function listPreferences(actor: Actor) {
  return asUser(actor, (tx) => tx<{ key: PreferenceKey; value: string; source: string; updated_at: Date }[]>`select key, value, source, updated_at from agent_preferences order by key`);
}

export async function setPreference(actor: Actor, key: PreferenceKey, value: string, source: "user" | "feedback") {
  const allowed = PREFERENCE_KEYS[key].values as readonly string[] | null;
  if (allowed ? !allowed.includes(value) : !/^[0-9a-f-]{36}$/i.test(value)) throw badRequest("Invalid value for this preference");
  await asUser(actor, async (tx) => {
    await tx`insert into agent_preferences (user_id, key, value, source) values (${actor.id}, ${key}, ${value}, ${source})
             on conflict (user_id, key) do update set value = excluded.value, source = excluded.source`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "agent.preference_saved", targetType: "agent_preference", metadata: { key, source } }, tx);
  });
  return { ok: true };
}

export async function deletePreference(actor: Actor, key: PreferenceKey) {
  await asUser(actor, (tx) => tx`delete from agent_preferences where key = ${key}`);
  return { ok: true };
}

// ------------------------------------------------------------------ workflows

interface WorkflowRow {
  id: string;
  name: string;
  purpose: string | null;
  task_type: string;
  input_template: JsonObject;
  required_capabilities: string[];
  verification: string | null;
  status: "draft" | "approved" | "disabled";
  success_count: number;
  failure_count: number;
  source_task_id: string | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const keyPrefix = (id: string) => `wf-${id.replace(/-/g, "")}-`;

export async function listWorkflows(actor: Actor) {
  return asUser(actor, async (tx) => {
    // Outcome counts come from the tasks each workflow started (their idempotency keys).
    await tx`
      update agent_workflows w set
        success_count = (select count(*) from tasks t where t.idempotency_key like 'wf-' || replace(w.id::text, '-', '') || '-%' and t.status = 'completed'),
        failure_count = (select count(*) from tasks t where t.idempotency_key like 'wf-' || replace(w.id::text, '-', '') || '-%' and t.status in ('failed', 'cancelled'))`;
    const rows = await tx<WorkflowRow[]>`select * from agent_workflows order by updated_at desc limit 100`;
    return rows.map((w) => ({ ...w, steps: LOCAL_TASK_TYPES.includes(w.task_type as LocalTaskType) ? LOCAL_TASK_STEPS[w.task_type as LocalTaskType].map((s) => s.title) : [] }));
  });
}

/** "Remember this as a workflow": a draft built from a finished computer task (ids and options only). */
export async function workflowFromTask(actor: Actor, taskId: string, name: string) {
  return asUser(actor, async (tx) => {
    const [t] = await tx<{ id: string; task_type: string; status: string; input_json: JsonObject; title: string }[]>`select id, task_type, status, input_json, title from tasks where id = ${taskId}`;
    if (!t) throw notFound("Task not found");
    if (!LOCAL_TASK_TYPES.includes(t.task_type as LocalTaskType)) throw badRequest("Only computer tasks can be saved as workflows");
    if (t.status !== "completed") throw conflict("Only a completed task can be saved as a workflow");
    if (t.task_type === "local_undo_changes") throw badRequest("Undo tasks cannot be saved as workflows");
    const { display: _d, ...input } = t.input_json;
    // A report's date-stamped file name is renewed on every run.
    if (t.task_type === "local_create_report") delete input.fileName;
    const caps = [...new Set(LOCAL_TASK_STEPS[t.task_type as LocalTaskType].map((s) => (LOCAL_STEPS as Record<string, { capability: Capability }>)[s.type]?.capability).filter(Boolean))] as string[];
    const [w] = await tx<{ id: string }[]>`
      insert into agent_workflows (user_id, name, purpose, task_type, input_template, required_capabilities, verification, source_task_id)
      values (${actor.id}, ${name}, ${t.title.slice(0, 300)}, ${t.task_type}, ${tx.json(input)}, ${caps}::text[], ${"Check the task result and its approvals each time"}, ${t.id}) returning id`;
    return { id: w!.id, status: "draft" as const };
  });
}

export async function updateWorkflow(actor: Actor, id: string, patch: { name?: string; status?: "draft" | "approved" | "disabled" }) {
  return asUser(actor, async (tx) => {
    const rows = await tx`update agent_workflows set name = coalesce(${patch.name ?? null}, name), status = coalesce(${patch.status ?? null}, status) where id = ${id} returning id`;
    if (!rows.length) throw notFound("Workflow not found");
    if (patch.status) await audit({ actorId: actor.id, actorRole: actor.role, action: `agent.workflow_${patch.status}`, targetType: "agent_workflow", targetId: id }, tx);
    return { ok: true };
  });
}

export async function deleteWorkflow(actor: Actor, id: string) {
  const rows = await asUser(actor, (tx) => tx`delete from agent_workflows where id = ${id} returning id`);
  if (!rows.length) throw notFound("Workflow not found");
  return { ok: true };
}

/** Runs an approved workflow as a new task: same permission checks, same approvals as any task. */
export async function runWorkflow(actor: Actor, id: string, deviceId: string) {
  const [w] = await asUser(actor, (tx) => tx<WorkflowRow[]>`select * from agent_workflows where id = ${id}`);
  if (!w) throw notFound("Workflow not found");
  if (w.status !== "approved") throw conflict(w.status === "draft" ? "Review and approve this workflow before running it" : "This workflow is disabled");
  const input: Record<string, unknown> = { ...w.input_template, deviceId };
  if (w.task_type === "local_create_report") input.fileName = `report-${new Date().toISOString().slice(0, 10)}.${input.format === "md" ? "md" : "csv"}`;
  const r = await createLocalTask(actor, { deviceId, taskType: w.task_type as LocalTaskType, input, idempotencyKey: `${keyPrefix(w.id)}${Date.now()}`, title: `${w.name} (workflow)` });
  await asUser(actor, (tx) => tx`update agent_workflows set last_used_at = now() where id = ${id}`);
  return r;
}

// ------------------------------------------------------------------ feedback

/** A preference that a "remember for next time" note suggests. Saved only when the user confirms it. */
export function suggestPreference(taskType: string, note: string): { key: PreferenceKey; value: string; label: string } | null {
  const n = note.toLowerCase();
  if (taskType === "local_create_report") {
    if (/\b(markdown|\.md|md file)\b/.test(n)) return { key: "report_format", value: "md", label: "Write reports as Markdown (.md)" };
    if (/\b(csv|excel|spreadsheet)\b/.test(n)) return { key: "report_format", value: "csv", label: "Write reports as CSV (opens in Excel)" };
  }
  if (taskType === "local_organize_files") {
    if (/\b(month|date)\b/.test(n)) return { key: "organize_by", value: "month", label: "Organise files by month" };
    if (/\bextension\b/.test(n)) return { key: "organize_by", value: "extension", label: "Organise files by extension" };
    if (/\btype\b/.test(n)) return { key: "organize_by", value: "type", label: "Organise files by type" };
  }
  if (taskType === "local_summarize_files") {
    if (/\b(shorter|short|brief)\b/.test(n)) return { key: "summary_length", value: "short", label: "Keep summaries short" };
    if (/\b(longer|detailed|more detail)\b/.test(n)) return { key: "summary_length", value: "detailed", label: "Make summaries more detailed" };
  }
  return null;
}

export async function addFeedback(actor: Actor, taskId: string, f: { correct: boolean; wrongStepKey?: string | null; note?: string | null; scope: "one_time" | "future" }) {
  return asUser(actor, async (tx) => {
    const [t] = await tx<{ id: string; task_type: string }[]>`select id, task_type from tasks where id = ${taskId}`;
    if (!t) throw notFound("Task not found");
    if (f.wrongStepKey) {
      const [s] = await tx`select 1 from task_steps where task_id = ${taskId} and step_key = ${f.wrongStepKey}`;
      if (!s) throw badRequest("Unknown step");
    }
    const [row] = await tx<{ id: string }[]>`
      insert into task_feedback (task_id, user_id, correct, wrong_step_key, note_encrypted, scope)
      values (${taskId}, ${actor.id}, ${f.correct}, ${f.wrongStepKey ?? null}, ${f.note ? encryptValue(f.note) : null}, ${f.scope}) returning id`;
    const suggestion = f.scope === "future" && f.note ? suggestPreference(t.task_type, f.note) : null;
    return { id: row!.id, suggestion };
  });
}

export async function listFeedback(actor: Actor, taskId: string | null) {
  const rows = await asUser(actor, (tx) => tx<{ id: string; task_id: string; correct: boolean; wrong_step_key: string | null; note_encrypted: string | null; scope: string; created_at: Date; title: string }[]>`
    select f.id, f.task_id, f.correct, f.wrong_step_key, f.note_encrypted, f.scope, f.created_at, t.title
      from task_feedback f join tasks t on t.id = f.task_id
     ${taskId ? tx`where f.task_id = ${taskId}` : tx``} order by f.created_at desc limit 100`);
  return rows.map(({ note_encrypted, ...r }) => ({ ...r, note: note_encrypted ? decryptValue(note_encrypted) : null }));
}

export async function deleteFeedback(actor: Actor, id: string) {
  const rows = await asUser(actor, (tx) => tx`delete from task_feedback where id = ${id} returning id`);
  if (!rows.length) throw notFound("Feedback not found");
  return { ok: true };
}

export const capabilityLabel = (c: string) => (CAPABILITIES as Record<string, { label: string }>)[c]?.label ?? c;
