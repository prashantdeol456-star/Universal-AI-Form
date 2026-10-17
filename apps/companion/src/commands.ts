import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { capOutput, commandEnv, commandTemplate, resolveInside, type CommandTemplate } from "@ufa/local-agent";
import type { StepReport } from "./api";

/**
 * Runs one allowlisted command template in an approved folder. No shell: the program and its
 * fixed arguments are passed to the OS directly. npm/npx run through Node's own npm-cli.js, so
 * Windows .cmd wrappers (which would need a shell) are never used. The child gets a minimal
 * environment without the companion's token, a timeout, and an output cap; the emergency stop
 * kills it with its child processes.
 */
export function resolveProgram(c: CommandTemplate): { file: string; args: string[] } {
  if (c.program === "npm" || c.program === "npx") {
    const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", `${c.program}-cli.js`);
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...c.args] };
    if (process.platform === "win32") throw new Error(`${c.program} was not found next to Node.js`);
    return { file: c.program, args: [...c.args] };
  }
  if (c.program === "node") return { file: process.execPath, args: [...c.args] };
  return { file: c.program === "python" && process.platform !== "win32" ? "python3" : c.program, args: [...c.args] };
}

function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export async function runCommand(root: string, commandId: string, signal: AbortSignal, progress: (m: string) => void): Promise<StepReport> {
  const c = commandTemplate(commandId);
  if (!c) return { outcome: "failed", message: "Unknown command; nothing was run" };
  if (c.requires && !existsSync(resolveInsideSafe(root, c.requires))) return { outcome: "failed", message: `This folder has no ${c.requires}; nothing was run` };
  let prog: { file: string; args: string[] };
  try {
    prog = resolveProgram(c);
  } catch (err) {
    return { outcome: "failed", message: err instanceof Error ? err.message : "Program not found" };
  }
  const started = Date.now();
  let output = "";
  let timedOut = false;
  let stopped = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    let child;
    try {
      child = spawn(prog.file, prog.args, { cwd: root, shell: false, env: commandEnv(process.env), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      resolve(null);
      return;
    }
    const add = (b: Buffer) => {
      if (output.length < 4 * 64 * 1024) output += b.toString("utf8");
      else output = output.slice(-2 * 64 * 1024) + b.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, c.timeoutMs);
    const tick = setInterval(() => progress(`Still running (${Math.round((Date.now() - started) / 1000)} s)`), 20_000);
    const onAbort = () => {
      stopped = true;
      if (child.pid) killTree(child.pid);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      output += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(tick);
      signal.removeEventListener("abort", onAbort);
      resolve(code);
    });
  });
  const capped = capOutput(output);
  const result = { commandId, exitCode, timedOut, stopped, durationMs: Date.now() - started, truncated: capped.truncated };
  if (stopped) {
    // A command that writes files and was cut off leaves an unknown state.
    return { outcome: c.effects === "writes_project" ? "uncertain" : "failed", message: "Stopped by the emergency stop", result, secret: capped.text };
  }
  return { outcome: "completed", message: timedOut ? "The command took too long and was stopped" : `Finished with exit code ${exitCode ?? "unknown"}`, result, secret: capped.text };
}

function resolveInsideSafe(root: string, rel: string): string {
  try {
    return resolveInside(root, rel);
  } catch {
    // .git and similar are protected for reading, but their presence is all that is checked here.
    return path.join(root, rel);
  }
}

/** True when running as Administrator (Windows) or root (Unix). The companion refuses to run then. */
export function isElevated(): boolean {
  if (process.platform === "win32") {
    // "net session" only succeeds in an elevated process.
    const r = spawnSync("net", ["session"], { windowsHide: true, stdio: "ignore" });
    return r.status === 0;
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}
