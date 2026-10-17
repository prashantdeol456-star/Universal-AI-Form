import "server-only";
import { COMMAND_TEMPLATES, LOCAL_TASK_INPUTS, LOCAL_TASK_TYPES, missingFor, planLocalTask, validateModelPlan, type LocalTaskType, type PlanContext, type PlanResult } from "@ufa/local-agent";
import type { JsonObject } from "@ufa/tasks";
import { asUser, type Actor } from "../db";
import { env } from "../env";
import { conflict, HttpError, notFound } from "../http";
import { tasks } from "../tasks/engine";
import { runLocalAgentModel, type LocalEngine } from "./ai";
import { planContextFor } from "./service";

/**
 * Natural-language planning for the companion (purpose plan_task). Only the user's own request
 * is planned; file or page content never reaches the planner. The rule-based planner runs
 * first; a model is asked only when the rules did not understand the request, and whatever it
 * proposes is validated against the task types, the device and its approved folders. Planning
 * creates nothing: the user presses Run, and side effects still need their own approvals.
 */
export function companionEnabled() {
  if (!env().COMPANION_ENABLED) throw new HttpError(404, "not_found", "The local companion is not enabled on this server");
}

async function contextFor(actor: Actor, deviceId: string): Promise<{ ctx: PlanContext; deviceName: string; stopped: boolean }> {
  const { device, folders } = await planContextFor(actor, deviceId);
  const { prefs, lastOrganize } = await asUser(actor, async (tx) => {
    const prefs = await tx<{ key: string; value: string }[]>`select key, value from agent_preferences`;
    const [last] = await tx<{ id: string }[]>`
      select id from tasks where task_type = 'local_organize_files' and status = 'completed' and input_json->>'deviceId' = ${deviceId}
       order by completed_at desc limit 1`;
    return { prefs, lastOrganize: last?.id ?? null };
  });
  const p = Object.fromEntries(prefs.map((x) => [x.key, x.value]));
  return {
    deviceName: device.name,
    stopped: device.stopped,
    ctx: {
      deviceId,
      capabilities: device.capabilities,
      folders,
      preferences: { reportFormat: p.report_format === "md" || p.report_format === "csv" ? p.report_format : undefined, outputFolderId: p.output_folder_id, summaryLength: p.summary_length === "detailed" || p.summary_length === "short" ? p.summary_length : undefined, organizeBy: p.organize_by === "month" || p.organize_by === "extension" || p.organize_by === "type" ? p.organize_by : undefined },
      lastOrganizeTaskId: lastOrganize,
    },
  };
}

const PLAN_SCHEMA = { type: "object", properties: { task_type: { type: "string", enum: [...LOCAL_TASK_TYPES] }, input: { type: "object" }, explanation: { type: "string" } }, required: ["task_type", "input", "explanation"] };

export async function planRequest(actor: Actor, deviceId: string, request: string): Promise<PlanResult & { engine: LocalEngine }> {
  const { ctx } = await contextFor(actor, deviceId);
  const rules = planLocalTask(request, ctx);
  // Rules understood it (or need a folder choice): no model needed.
  if (rules.ok || /Which folder|No folder is approved|no completed organise/i.test(rules.question)) return { ...rules, engine: { provider: "rules", reason: null } };
  const { raw, engine } = await runLocalAgentModel(actor, "plan_task", {
    cloudAllowed: true,
    system: [
      "You turn a user's request into ONE task for their computer, or refuse. Allowed task types and inputs:",
      "local_summarize_files {folderId, nameContains?, extensions?: string[], maxFiles?}",
      "local_organize_files {folderId, by: type|extension|month}",
      "local_create_report {sourceFolderId, outputFolderId, format: csv|md, fileName, nameContains?}",
      `local_run_command {folderId, commandId: ${COMMAND_TEMPLATES.map((c) => c.id).join("|")}}`,
      "Use only these folder ids: " + ctx.folders.map((f) => `${f.id} = “${f.label}” (${f.access.join("/")})`).join("; "),
      "If the request does not fit, use local_summarize_files with an explanation starting with 'UNSUPPORTED'. Never invent commands, folders or paths.",
    ].join("\n"),
    user: request.slice(0, 500),
    schema: PLAN_SCHEMA,
  });
  if (!raw) return { ...rules, engine };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...rules, engine: { provider: "rules", reason: "invalid_model_output" } };
  }
  if ((parsed as { explanation?: string }).explanation?.startsWith("UNSUPPORTED")) return { ...rules, engine };
  const v = validateModelPlan(parsed, ctx);
  return { ...(v.ok ? v : rules), engine: v.ok ? engine : { provider: "rules", reason: "invalid_model_output" } };
}

/**
 * Creates a computer task after checking that the device and every folder are the user's own,
 * active and approved, and that nothing is missing. The approval steps inside the task are
 * unchanged by how the task was started (plan, workflow or form).
 */
export async function createLocalTask(actor: Actor, req: { deviceId: string; taskType: LocalTaskType; input: Record<string, unknown>; idempotencyKey?: string | null; title?: string | null }) {
  const { ctx, deviceName, stopped } = await contextFor(actor, req.deviceId);
  if (stopped) throw conflict("Emergency stop is on for this device. Clear it on the Companion page first.");
  const parsed = LOCAL_TASK_INPUTS[req.taskType].safeParse({ ...req.input, deviceId: req.deviceId });
  if (!parsed.success) throw new HttpError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid task input");
  const input = parsed.data as Record<string, unknown>;
  const missing = missingFor({ taskType: req.taskType, input }, ctx);
  if (missing.length) throw conflict("Some permissions are missing", { missing });
  const label = (id: unknown) => ctx.folders.find((f) => f.id === id)?.label;
  const folder = label(input.folderId ?? input.sourceFolderId);
  if (!folder) throw notFound("Folder not found");
  const display = { device: deviceName, folder, outputFolder: label(input.outputFolderId) ?? null };
  const { task, created } = await tasks().createTask(actor, { taskType: req.taskType, title: req.title ?? null, input: { ...input, display } as JsonObject, idempotencyKey: req.idempotencyKey ?? null });
  const { lease_token: _t, lease_owner: _o, ...view } = task;
  return { task: view, created };
}
