import "server-only";
import { AGENTS, agentFor, MISSION_LIMITS, splitRequest, targetDevices, type LocalTaskType, type WorkerAgent } from "@ufa/local-agent";
import type { JsonObject } from "@ufa/tasks";
import { redact } from "@ufa/security";
import { z } from "zod";
import { audit } from "../audit";
import { asUser, db, decryptValue, encryptValue, type Actor } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { tasks } from "../tasks/engine";
import { runLocalAgentModel } from "./ai";
import { createLocalTask, missingForTask, planRequest } from "./planner";
import { listDevices } from "./service";

/**
 * Multi-agent missions (AI browser Phase 8).
 *
 * Planner agent: splits the request into ordered parts, picks the computers of each part, and
 * plans every part with the single-task planner (rules first, validated model plans). Nothing
 * is created until the user starts the mission.
 * Coordinator (server runner): starts the parts of the current group as normal computer tasks
 * (File / Command agent), waits for them, then moves to the next group. A failed or cancelled
 * part pauses the mission; the user retries, skips or cancels. No part is ever retried
 * automatically, and every task keeps its own approvals.
 * Reviewer agent: one review from the parts' result metadata (never file content); rules, or the
 * self-hosted model, or cloud AI only when every involved computer allows cloud AI.
 */
export type MissionStatus = "planned" | "running" | "paused" | "completed" | "failed" | "cancelled";
type PartStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

interface MissionRow {
  id: string;
  user_id: string;
  title: string;
  request_encrypted: string;
  status: MissionStatus;
  status_reason: string | null;
  review_encrypted: string | null;
  review_provider: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}
interface PartRow {
  id: string;
  mission_id: string;
  seq: number;
  grp: number;
  agent: WorkerAgent;
  device_id: string;
  task_type: LocalTaskType;
  input: JsonObject;
  explanation: string;
  task_id: string | null;
  attempts: number;
  status: PartStatus;
  error: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ Planner agent

export async function planMission(actor: Actor, request: string, defaultDeviceId: string | null) {
  const devices = (await listDevices(actor)).filter((d) => d.status === "active");
  if (!devices.length) throw conflict("Pair a computer first");
  const parts = splitRequest(request);
  if (!parts.length) return { ok: false as const, question: "What should your computers do?" };
  if (parts.length > MISSION_LIMITS.parts) return { ok: false as const, question: `Split this into at most ${MISSION_LIMITS.parts} steps.` };
  const planned: Array<{ seq: number; grp: number; agent: WorkerAgent; deviceId: string; deviceName: string; taskType: LocalTaskType; input: Record<string, unknown>; explanation: string; steps: string[]; missing: string[] }> = [];
  const notes: string[] = [];
  for (const [i, part] of parts.entries()) {
    const target = targetDevices(part, devices, defaultDeviceId);
    if ("question" in target) return { ok: false as const, question: target.question };
    const fanOut = target.deviceIds.length > 1;
    let planned_here = 0;
    for (const deviceId of target.deviceIds) {
      const name = devices.find((d) => d.id === deviceId)!.name;
      const r = await planRequest(actor, deviceId, target.text);
      if (!r.ok) {
        // "On all computers": a computer without a matching folder is left out (and said so).
        if (fanOut) {
          notes.push(`Step ${i + 1} skips ${name}: ${r.question}`);
          continue;
        }
        return { ok: false as const, question: `Step ${i + 1} (“${clip(part, 60)}”) on ${name}: ${r.question}` };
      }
      if (planned.length >= MISSION_LIMITS.subtasks) return { ok: false as const, question: `That is more than ${MISSION_LIMITS.subtasks} tasks; make it smaller.` };
      planned.push({ seq: planned.length + 1, grp: i + 1, agent: agentFor(r.plan.taskType), deviceId, deviceName: name, taskType: r.plan.taskType, input: r.plan.input, explanation: clip(r.plan.explanation, 400), steps: r.plan.steps, missing: r.plan.missing });
      planned_here++;
    }
    if (!planned_here) return { ok: false as const, question: `Step ${i + 1} (“${clip(part, 60)}”) fits none of your computers. ${notes.at(-1) ?? ""}`.trim() };
  }
  const title = clip(parts.length === 1 ? parts[0]! : `${parts[0]} (+${parts.length - 1} more)`, 200);
  const id = await asUser(actor, async (tx) => {
    const [m] = await tx<{ id: string }[]>`insert into agent_missions (user_id, title, request_encrypted) values (${actor.id}, ${title}, ${encryptValue(request)}) returning id`;
    for (const p of planned) {
      const { deviceId: _d, ...input } = p.input;
      await tx`insert into agent_mission_tasks (mission_id, user_id, seq, grp, agent, device_id, task_type, input, explanation)
               values (${m!.id}, ${actor.id}, ${p.seq}, ${p.grp}, ${p.agent}, ${p.deviceId}, ${p.taskType}, ${tx.json(input as JsonObject)}, ${p.explanation})`;
    }
    return m!.id;
  });
  return { ok: true as const, missionId: id, notes, parts: planned.map(({ input: _i, ...p }) => p) };
}

// ------------------------------------------------------------------ views

export async function listMissions(actor: Actor) {
  const rows = await asUser(actor, (tx) => tx<(MissionRow & { parts: number; done: number })[]>`
    select m.*, (select count(*)::int from agent_mission_tasks p where p.mission_id = m.id) as parts,
           (select count(*)::int from agent_mission_tasks p where p.mission_id = m.id and p.status in ('completed', 'skipped')) as done
      from agent_missions m order by m.created_at desc limit 30`);
  return rows.map((m) => ({ id: m.id, title: m.title, status: m.status, statusReason: m.status_reason, parts: m.parts, done: m.done, createdAt: m.created_at.toISOString() }));
}

export async function getMission(actor: Actor, id: string) {
  const { m, parts, approvals, taskRows } = await asUser(actor, async (tx) => {
    const [m] = await tx<MissionRow[]>`select * from agent_missions where id = ${id}`;
    if (!m) throw notFound("Mission not found");
    const parts = await tx<PartRow[]>`select * from agent_mission_tasks where mission_id = ${id} order by seq`;
    const taskIds = parts.map((p) => p.task_id).filter((x): x is string => !!x);
    const taskRows = taskIds.length ? await tx<{ id: string; status: string; title: string; error_message: string | null }[]>`select id, status, title, error_message from tasks where id = any(${taskIds}::uuid[])` : [];
    const approvals = taskIds.length
      ? await tx<{ id: string; task_id: string; action_summary: string; expires_at: Date }[]>`select id, task_id, action_summary, expires_at from approvals where status = 'pending' and task_id = any(${taskIds}::uuid[])`
      : [];
    return { m, parts, approvals, taskRows };
  });
  const devices = await listDevices(actor);
  const review = m.review_encrypted ? (JSON.parse(decryptValue(m.review_encrypted)) as { overview: string | null; lines: string[] }) : null;
  return {
    id: m.id,
    title: m.title,
    request: decryptValue(m.request_encrypted),
    status: m.status,
    statusReason: m.status_reason,
    startedAt: m.started_at?.toISOString() ?? null,
    completedAt: m.completed_at?.toISOString() ?? null,
    review,
    reviewProvider: m.review_provider,
    agents: AGENTS,
    parts: parts.map((p) => {
      const t = taskRows.find((x) => x.id === p.task_id);
      const d = devices.find((x) => x.id === p.device_id);
      return {
        seq: p.seq,
        grp: p.grp,
        agent: p.agent,
        deviceId: p.device_id,
        deviceName: d?.name ?? "removed computer",
        deviceOnline: d?.online ?? false,
        taskType: p.task_type,
        explanation: p.explanation,
        status: p.status,
        error: p.error,
        attempts: p.attempts,
        taskId: p.task_id,
        taskStatus: t?.status ?? null,
        approvals: approvals.filter((a) => a.task_id === p.task_id).map((a) => ({ id: a.id, summary: a.action_summary, expiresAt: a.expires_at.toISOString() })),
      };
    }),
  };
}

// ------------------------------------------------------------------ controls

const setMission = (actor: Actor, id: string, from: MissionStatus[], to: MissionStatus, reason: string | null) =>
  asUser(actor, (tx) => tx`
    update agent_missions set status = ${to}, status_reason = ${reason},
      started_at = case when ${to} = 'running' then coalesce(started_at, now()) else started_at end,
      completed_at = case when ${to} in ('completed', 'failed', 'cancelled') then now() else completed_at end
     where id = ${id} and status = any(${from}::text[]) returning id`);

const loadParts = (actor: Actor, id: string) => asUser(actor, (tx) => tx<PartRow[]>`select * from agent_mission_tasks where mission_id = ${id} order by seq`);
const setPart = (actor: Actor, partId: string, patch: { status: PartStatus; error?: string | null; taskId?: string | null; attempts?: number }) =>
  asUser(actor, (tx) => tx`
    update agent_mission_tasks set status = ${patch.status}, error = ${patch.error === undefined ? null : patch.error},
      task_id = coalesce(${patch.taskId ?? null}::uuid, task_id), attempts = coalesce(${patch.attempts ?? null}::smallint, attempts)
     where id = ${partId}`);

export async function startMission(actor: Actor, id: string) {
  const parts = await loadParts(actor, id);
  if (!parts.length) throw notFound("Mission not found");
  const missing: string[] = [];
  for (const p of parts) for (const m of await missingForTask(actor, p.device_id, p.task_type, p.input)) missing.push(`Step ${p.seq}: ${m}`);
  if (missing.length) throw conflict("Some permissions are missing", { missing });
  const rows = await setMission(actor, id, ["planned"], "running", null);
  if (!rows.length) throw conflict("This mission was already started");
  await audit({ actorId: actor.id, actorRole: actor.role, action: "agent.mission_started", targetType: "agent_mission", targetId: id, metadata: { parts: parts.length } });
  await advanceMission(actor, id);
  return { ok: true };
}

export async function controlMission(actor: Actor, id: string, action: "pause" | "resume" | "cancel" | "retry" | "skip", seq: number | null) {
  const parts = await loadParts(actor, id);
  if (!parts.length) throw notFound("Mission not found");
  const childTasks = parts.filter((p) => p.task_id && p.status === "running").map((p) => p.task_id!);
  if (action === "pause") {
    if (!(await setMission(actor, id, ["running"], "paused", "Paused by you")).length) throw conflict("Only a running mission can be paused");
    for (const t of childTasks) await tasks().pause(actor, t).catch(() => {});
    return { ok: true };
  }
  if (action === "cancel") {
    if (!(await setMission(actor, id, ["planned", "running", "paused"], "cancelled", "Cancelled by you")).length) throw conflict("This mission has already finished");
    for (const t of childTasks) await tasks().cancel(actor, t).catch(() => {});
    for (const p of parts) if (p.status === "pending" || p.status === "running") await setPart(actor, p.id, { status: "cancelled" });
    await audit({ actorId: actor.id, actorRole: actor.role, action: "agent.mission_cancelled", targetType: "agent_mission", targetId: id });
    return { ok: true };
  }
  if (action === "resume") {
    if (parts.some((p) => p.status === "failed" || p.status === "cancelled")) throw conflict("Retry or skip the failed step first");
    if (!(await setMission(actor, id, ["paused"], "running", null)).length) throw conflict("Only a paused mission can be resumed");
    // Paused tasks are resumed by the user on their own pages (never automatically).
    await advanceMission(actor, id);
    return { ok: true };
  }
  const part = parts.find((p) => p.seq === seq);
  if (!part) throw badRequest("Unknown step");
  if (action === "retry") {
    if (part.status !== "failed" && part.status !== "cancelled") throw conflict("Only a failed or cancelled step can be retried");
    if (part.attempts >= 5) throw conflict("This step was tried 5 times");
    await setPart(actor, part.id, { status: "pending" });
  } else {
    if (!["failed", "cancelled", "pending"].includes(part.status)) throw conflict("Only a waiting, failed or cancelled step can be skipped");
    await setPart(actor, part.id, { status: "skipped" });
  }
  const others = parts.filter((p) => p.id !== part.id);
  if (!others.some((p) => p.status === "failed" || p.status === "cancelled")) await setMission(actor, id, ["paused"], "running", null);
  await advanceMission(actor, id);
  return { ok: true };
}

export async function deleteMission(actor: Actor, id: string) {
  const rows = await asUser(actor, (tx) => tx`delete from agent_missions where id = ${id} and status in ('planned', 'completed', 'failed', 'cancelled') returning id`);
  if (!rows.length) throw conflict("Cancel the mission before deleting it");
  return { ok: true };
}

// ------------------------------------------------------------------ coordinator

/** Moves one running mission forward: syncs part states, starts the next group, or finishes with a review. */
export async function advanceMission(actor: Actor, id: string): Promise<void> {
  const [m] = await asUser(actor, (tx) => tx<MissionRow[]>`select * from agent_missions where id = ${id}`);
  if (!m || m.status !== "running") return;
  const parts = await loadParts(actor, id);
  for (const p of parts.filter((x) => x.status === "running" && x.task_id)) {
    const [t] = await asUser(actor, (tx) => tx<{ status: string; error_message: string | null }[]>`select status, error_message from tasks where id = ${p.task_id}`);
    if (!t) {
      p.status = "failed";
      p.error = "The task was deleted";
    } else if (t.status === "completed") p.status = "completed";
    else if (t.status === "failed") {
      p.status = "failed";
      p.error = clip(t.error_message ?? "The task failed", 300);
    } else if (t.status === "cancelled") {
      p.status = "cancelled";
      p.error = "The task was cancelled";
    } else continue;
    await setPart(actor, p.id, { status: p.status, error: p.error });
  }
  const bad = parts.find((p) => p.status === "failed" || p.status === "cancelled");
  if (bad) {
    await setMission(actor, id, ["running"], "paused", clip(`Step ${bad.seq} ${bad.status}: ${bad.error ?? ""}. Retry it, skip it or cancel the mission.`, 300));
    return;
  }
  const open = parts.filter((p) => p.status === "pending" || p.status === "running");
  if (!open.length) {
    await finishMission(actor, m, parts);
    return;
  }
  const grp = Math.min(...open.map((p) => p.grp));
  for (const p of open.filter((x) => x.grp === grp && x.status === "pending")) {
    const attempt = p.attempts + 1;
    try {
      const r = await createLocalTask(actor, {
        deviceId: p.device_id,
        taskType: p.task_type,
        input: p.input,
        idempotencyKey: `ms-${id.replace(/-/g, "")}-${p.seq}-${attempt}`,
        title: clip(`${m.title.slice(0, 80)} · step ${p.seq}`, 200),
      });
      await setPart(actor, p.id, { status: "running", taskId: r.task.id, attempts: attempt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const details = (err as { details?: { missing?: string[] } }).details?.missing?.join("; ");
      await setPart(actor, p.id, { status: "failed", error: clip(details ? `${msg}: ${details}` : msg, 300), attempts: attempt });
      await setMission(actor, id, ["running"], "paused", clip(`Step ${p.seq} could not start: ${details ?? msg}`, 300));
      return;
    }
  }
}

// ------------------------------------------------------------------ Reviewer agent

function describe(type: string, steps: Array<{ step_key: string; result_json: JsonObject | null }>): string {
  const r = (k: string) => steps.find((s) => s.step_key === k)?.result_json ?? {};
  switch (type) {
    case "local_summarize_files":
      return `read ${Number(r("summary").read ?? 0)} of ${Number(r("summary").files ?? 0)} file(s)`;
    case "local_organize_files":
      return `moved ${Number(r("apply").moved ?? 0)} file(s)${r("apply").skipped ? `, ${Number(r("apply").skipped)} skipped` : ""}`;
    case "local_create_report":
      return r("write").fileName ? `wrote ${String(r("write").fileName)} (${Number(r("write").rows ?? 0)} rows)` : "no report written";
    case "local_run_command":
      return `${String(r("review").verdict ?? "unknown")} (exit code ${String(r("run").exitCode ?? "?")})`;
    case "local_undo_changes":
      return `moved ${Number(r("undo").restored ?? 0)} file(s) back`;
    default:
      return "";
  }
}

async function finishMission(actor: Actor, m: MissionRow, parts: PartRow[]) {
  const devices = await listDevices(actor);
  const lines: string[] = [];
  for (const p of parts) {
    const name = devices.find((d) => d.id === p.device_id)?.name ?? "computer";
    if (p.status === "skipped") {
      lines.push(`Step ${p.seq} · ${AGENTS[p.agent].label} on ${name}: skipped by you`);
      continue;
    }
    const view = p.task_id ? await tasks().getTask(actor, p.task_id).catch(() => null) : null;
    const folder = (view?.task.input_json as { display?: { folder?: string } } | undefined)?.display?.folder ?? "a folder";
    const what: Record<string, string> = { local_summarize_files: "summarised", local_organize_files: "organised", local_create_report: "made a report of", local_run_command: "ran a command in", local_undo_changes: "undid the organise of" };
    lines.push(`Step ${p.seq} · ${AGENTS[p.agent].label} on ${name}: ${what[p.task_type] ?? "worked on"} “${folder}” — ${view ? describe(p.task_type, view.steps as never) : "done"}`);
  }
  let overview: string | null = null;
  let provider: "rules" | "local" | "gemini" = "rules";
  // Metadata only (counts, verdicts), never file content. Cloud only if every computer allows cloud AI.
  const involved = devices.filter((d) => parts.some((p) => p.device_id === d.id));
  const { raw, engine } = await runLocalAgentModel(actor, "review_task_result", {
    cloudAllowed: involved.length > 0 && involved.every((d) => d.cloudAiAllowed),
    system: "You review the outcome of a multi-step job done on the user's computers. In two or three sentences say what was done, what failed or was skipped, and what the user may want to check. Use only the lines given; do not invent anything.",
    user: lines.join("\n"),
    schema: { type: "object", properties: { overview: { type: "string" } }, required: ["overview"] },
  }).catch(() => ({ raw: null, engine: { provider: "rules" as const, reason: "provider_error" } }));
  if (raw) {
    try {
      const o = z.object({ overview: z.string().min(1).max(1000) }).parse(JSON.parse(raw));
      overview = redact(o.overview);
      provider = engine.provider === "rules" ? "rules" : engine.provider;
    } catch {
      overview = null;
    }
  }
  const done = parts.filter((p) => p.status === "completed").length;
  overview ??= `${done} of ${parts.length} step(s) finished${parts.length - done ? `, ${parts.length - done} skipped` : ""}.`;
  await asUser(actor, (tx) => tx`
    update agent_missions set status = 'completed', completed_at = now(), status_reason = null,
      review_encrypted = ${encryptValue(JSON.stringify({ overview, lines }))}, review_provider = ${provider}
     where id = ${m.id} and status = 'running'`);
}

/** Runner hook: every running mission of every user (each advanced as its owner, under RLS). */
export async function advanceMissions(): Promise<number> {
  const rows = await db().system<{ id: string; user_id: string; role: string }[]>`
    select m.id, m.user_id, u.role from agent_missions m join users u on u.id = m.user_id where m.status = 'running' and u.deleted_at is null limit 50`;
  for (const r of rows) {
    try {
      await advanceMission({ id: r.user_id, role: r.role }, r.id);
    } catch (err) {
      console.error(`[missions] advance failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
  return rows.length;
}

/** Pending approvals of computer tasks, for the phone-friendly approvals list. */
export async function pendingLocalApprovals(actor: Actor) {
  const rows = await asUser(actor, (tx) => tx<{ id: string; task_id: string; title: string; action_summary: string; expires_at: Date }[]>`
    select a.id, a.task_id, t.title, a.action_summary, a.expires_at from approvals a join tasks t on t.id = a.task_id
     where a.status = 'pending' and t.task_type like 'local\\_%' order by a.created_at limit 20`);
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, title: r.title, summary: r.action_summary, expiresAt: r.expires_at.toISOString() }));
}
