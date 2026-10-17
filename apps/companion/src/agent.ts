import os from "node:os";
import { checkLocalStep, type FolderGrant, type OrganizeBy } from "@ufa/local-agent";
import { ApiError, call, type Claim, type HeartbeatReply, type StepReport } from "./api";
import { runCommand } from "./commands";
import { saveConfig, type CompanionConfig } from "./config";
import { applyChanges, listStep, planOrganizeStep, summarizeFiles, undoChanges, writeReport } from "./files";

/**
 * The companion's work loop: heartbeat (folders out; stop state, capabilities and folder
 * revocations in), claim the next step addressed to this device, check the local policy, run
 * it, report. The emergency stop aborts the running step at the next heartbeat or progress
 * report; no step starts while it is on. Uncertain outcomes are reported as such (never retried here).
 */
export const displayPath = (p: string) => {
  const home = os.homedir();
  return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
};

export interface AgentState {
  stopped: boolean;
  capabilities: string[];
  aiExcerptsAllowed: boolean;
  current: AbortController | null;
}

const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

export async function heartbeat(cfg: CompanionConfig, state: AgentState, localAi: "available" | "unavailable" | "unknown" = "unknown") {
  const reply = await call<HeartbeatReply>(cfg.server, "/api/companion/device/heartbeat", {
    bearer: cfg.token,
    body: { version: VERSION, localAi, folders: cfg.folders.map((f) => ({ id: f.id, label: f.label, displayPath: displayPath(f.path), access: f.access })) },
  });
  if (reply.revokedFolderIds.length) {
    const removed = cfg.folders.filter((f) => reply.revokedFolderIds.includes(f.id));
    cfg.folders = cfg.folders.filter((f) => !reply.revokedFolderIds.includes(f.id));
    saveConfig(cfg);
    for (const f of removed) log(`Folder “${f.label}” was revoked from the dashboard and removed here.`);
  }
  if (reply.stop && !state.stopped) {
    log("EMERGENCY STOP is on: stopping the current action and taking no new work.");
    state.current?.abort();
  }
  if (!reply.stop && state.stopped) log("Emergency stop cleared. Paused tasks stay paused until you resume them.");
  state.stopped = reply.stop;
  state.capabilities = reply.capabilities;
  state.aiExcerptsAllowed = reply.aiExcerptsAllowed;
  return reply;
}

export const VERSION = "0.1.0";

function folderFor(cfg: CompanionConfig, claim: Claim): { folder: FolderGrant | null; other?: FolderGrant | null } {
  const i = claim.task.input;
  const get = (id: unknown) => cfg.folders.find((f) => f.id === id) ?? null;
  if (claim.step.type === "local.write_report") return { folder: get(i.outputFolderId), other: get(i.sourceFolderId) };
  if (claim.task.type === "local_create_report") return { folder: get(i.sourceFolderId) };
  return { folder: get(i.folderId) };
}

/** Runs one claimed step after the local policy check. */
export async function executeStep(cfg: CompanionConfig, state: AgentState, claim: Claim, signal: AbortSignal, progress: (m: string) => void): Promise<StepReport> {
  const { folder, other } = folderFor(cfg, claim);
  const decision = checkLocalStep({ stepType: claim.step.type, capabilities: claim.capabilities, folder, stopped: state.stopped });
  if (!decision.allowed) return { outcome: "failed", message: decision.reason };
  const i = claim.task.input;
  const root = folder!.path;
  switch (claim.step.type) {
    case "local.list_files":
      return listStep(root, { nameContains: (i.nameContains as string | null) ?? null, extensions: (i.extensions as string[] | undefined) ?? [] }, signal);
    case "local.summarize_files":
      return summarizeFiles(root, { nameContains: (i.nameContains as string | null) ?? null, extensions: (i.extensions as string[]) ?? [], maxFiles: Number(i.maxFiles ?? 10), detail: i.detail === "detailed" ? "detailed" : "short" }, { excerpts: claim.aiExcerptsAllowed, signal });
    case "local.plan_organize":
      return planOrganizeStep(root, claim.task.id, folder!.id, (i.by as OrganizeBy) ?? "type");
    case "local.apply_changes":
      return applyChanges(root, claim.task.id, String(claim.previous.approve?.planSha ?? ""), signal, progress);
    case "local.undo_changes":
      if (String(claim.previous.approve?.operationTaskId ?? "") !== String(i.operationTaskId)) return { outcome: "failed", message: "The undo does not match what you approved" };
      return undoChanges(root, String(i.operationTaskId), folder!.id, signal);
    case "local.write_report": {
      if (!other || !other.access.includes("read")) return { outcome: "failed", message: "The source folder is not approved for reading on this computer" };
      return writeReport(other.path, root, { fileName: String(i.fileName), format: i.format === "md" ? "md" : "csv", nameContains: (i.nameContains as string | null) ?? null }, String(claim.previous.approve?.fileName ?? ""));
    }
    case "local.run_command":
      if (String(claim.previous.approve?.commandId ?? "") !== String(i.commandId)) return { outcome: "failed", message: "The command does not match what you approved; nothing was run" };
      return runCommand(root, String(i.commandId), signal, progress);
    default:
      return { outcome: "failed", message: `Unknown local action "${claim.step.type}"` };
  }
}

async function report(cfg: CompanionConfig, claim: Claim, r: StepReport) {
  return call<{ ok: boolean; stop: boolean }>(cfg.server, `/api/companion/device/steps/${claim.task.id}/${claim.step.id}/report`, { bearer: cfg.token, body: { leaseToken: claim.leaseToken, ...r } });
}

/** Claims and runs one step. Returns false when there was nothing to do. */
export async function runOne(cfg: CompanionConfig, state: AgentState): Promise<boolean> {
  if (state.stopped) return false;
  const r = await call<{ claim: Claim | null; stopped: boolean; refused?: string }>(cfg.server, "/api/companion/device/claim", { bearer: cfg.token });
  if (r.refused) log(`A step was refused by the server: ${r.refused}`);
  if (!r.claim) {
    state.stopped = r.stopped;
    return Boolean(r.refused);
  }
  const claim = r.claim;
  log(`Running “${claim.step.type}” for task ${claim.task.id.slice(0, 8)}…`);
  const ctl = new AbortController();
  state.current = ctl;
  const progress = (m: string) => {
    report(cfg, claim, { outcome: "progress", message: m })
      .then((x) => {
        if (x.stop) ctl.abort();
      })
      .catch(() => {});
  };
  // Keeps the lease alive and notices the emergency stop while a long action runs.
  const beat = setInterval(() => {
    heartbeat(cfg, state).catch(() => {});
    progress("Working…");
  }, 5_000);
  let out: StepReport;
  try {
    out = await executeStep(cfg, state, claim, ctl.signal, progress);
  } catch (err) {
    // An error part-way through a step with side effects leaves an unknown state.
    const sideEffects = ["local.apply_changes", "local.undo_changes", "local.write_report", "local.run_command"].includes(claim.step.type);
    out = { outcome: sideEffects ? "uncertain" : "failed", message: err instanceof Error ? err.message.slice(0, 200) : "Failed" };
  } finally {
    clearInterval(beat);
    state.current = null;
  }
  await report(cfg, claim, out);
  log(`${out.outcome}: ${out.message ?? ""}`);
  return true;
}

async function probeLocalAi(): Promise<"available" | "unavailable"> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    return r.ok ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function runLoop(cfg: CompanionConfig, opts: { once: boolean }) {
  const state: AgentState = { stopped: false, capabilities: [], aiExcerptsAllowed: false, current: null };
  const localAi = await probeLocalAi();
  let lastBeat = 0;
  // --once: keep working while steps arrive; exit after ~8 s with nothing to do.
  let idle = 0;
  log(`Connected to ${cfg.server} as “${cfg.name}”. ${cfg.folders.length} approved folder(s). Press Ctrl+C to quit.`);
  for (;;) {
    try {
      if (Date.now() - lastBeat > 15_000) {
        await heartbeat(cfg, state, localAi);
        lastBeat = Date.now();
      }
      const did = await runOne(cfg, state);
      if (did) {
        idle = 0;
        continue;
      }
      if (opts.once && ++idle > 4) return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        log(`The server no longer accepts this device (${err.message}). Run "ufa-companion pair" again.`);
        process.exitCode = 2;
        return;
      }
      log(`Connection problem: ${err instanceof Error ? err.message : String(err)}. Retrying…`);
      if (opts.once) {
        process.exitCode = 1;
        return;
      }
    }
    await new Promise((r) => setTimeout(r, opts.once ? 2000 : 4000));
  }
}
