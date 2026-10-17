import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOLDER_ACCESS, PathPolicyError, validateGrantRoot, type FolderAccess } from "@ufa/local-agent";
import { heartbeat, runLoop, VERSION, displayPath } from "./agent";
import { ApiError, call } from "./api";
import { isElevated } from "./commands";
import { checkServerUrl, configDir, loadConfig, requireConfig, saveConfig } from "./config";

const HELP = `ufa-companion ${VERSION} — approved actions on this computer for your AI Form Assistant

  pair --server <https://your-server> [--name "My laptop"]   pair this computer with your account
  folders add <folder> [--read] [--write] [--run] [--label <name>]
                                    approve a folder (default: read only)
  folders list                      show approved folders
  folders remove <id or label>      remove a folder approval
  run [--once]                      connect and do approved work (Ctrl+C to quit)
  status                            show pairing, folders and the stop state
  unpair                            remove this computer from your account and forget the token

Nothing runs without a task you started in the dashboard, and every change (moving files,
writing a file, running a command) needs your approval there first.`;

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function pair(args: string[]) {
  const server = checkServerUrl(flag(args, "--server") ?? "");
  const name = (flag(args, "--name") ?? os.hostname()).slice(0, 60);
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const pollSecret = randomBytes(32).toString("base64url");
  const start = await call<{ pairingId: string; code: string; expiresAt: string }>(server, "/api/companion/pair/start", { bearer: pollSecret, body: { name, platform, version: VERSION } });
  console.log(`\n  Pairing code:  ${start.code}\n\n  Open ${server}/dashboard/companion, enter this code and check the name “${name}”.\n  The code expires at ${new Date(start.expiresAt).toLocaleTimeString()}.\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await call<{ status: string; deviceId?: string; token?: string }>(server, "/api/companion/pair/poll", { bearer: pollSecret, body: { pairingId: start.pairingId } });
    if (r.status === "expired") throw new Error("The code expired. Run pair again.");
    if (r.status === "paired" && r.token && r.deviceId) {
      const old = loadConfig();
      saveConfig({ server, deviceId: r.deviceId, token: r.token, name, folders: old?.server === server ? old.folders : [] });
      console.log(`Paired. This computer has no permissions yet: grant them on the Companion page, then approve folders with "folders add".`);
      return;
    }
  }
}

function folders(args: string[]) {
  const cfg = requireConfig();
  const [sub, target] = args;
  if (sub === "list" || !sub) {
    if (!cfg.folders.length) console.log("No folders approved yet.");
    for (const f of cfg.folders) console.log(`${f.id}  ${f.label.padEnd(20)} ${f.access.join("+").padEnd(15)} ${displayPath(f.path)}`);
    return;
  }
  if (sub === "add") {
    if (!target) throw new Error("Give a folder: folders add <folder>");
    const real = validateGrantRoot(target);
    const access = FOLDER_ACCESS.filter((a) => args.includes(`--${a}`));
    const grant: FolderAccess[] = access.length ? [...new Set<FolderAccess>(["read", ...access])] : ["read"];
    const label = (flag(args, "--label") ?? path.basename(real)).trim().slice(0, 60);
    if (!label || /[\r\n\0]/.test(label)) throw new Error("Invalid label");
    const existing = cfg.folders.find((f) => f.path.toLowerCase() === real.toLowerCase());
    if (existing) {
      existing.access = grant;
      existing.label = label;
    } else {
      if (cfg.folders.some((f) => f.label.toLowerCase() === label.toLowerCase())) throw new Error(`The label “${label}” is already used; pass --label`);
      cfg.folders.push({ id: randomUUID(), label, path: real, access: grant });
    }
    saveConfig(cfg);
    console.log(`Approved “${label}” (${grant.join(" + ")}): ${displayPath(real)}`);
    return;
  }
  if (sub === "remove") {
    const before = cfg.folders.length;
    cfg.folders = cfg.folders.filter((f) => f.id !== target && f.label.toLowerCase() !== String(target).toLowerCase());
    if (cfg.folders.length === before) throw new Error("No such folder");
    saveConfig(cfg);
    console.log("Removed. The server forgets it at the next connection.");
    return;
  }
  throw new Error(`Unknown folders command "${sub}"`);
}

async function status() {
  const cfg = requireConfig();
  console.log(`Server: ${cfg.server}\nDevice: ${cfg.name} (${cfg.deviceId})\nSettings: ${configDir()}`);
  folders(["list"]);
  const state = { stopped: false, capabilities: [] as string[], aiExcerptsAllowed: false, current: null };
  try {
    await heartbeat(cfg, state);
    console.log(`Capabilities: ${state.capabilities.join(", ") || "none granted"}\nEmergency stop: ${state.stopped ? "ON" : "off"}`);
  } catch (err) {
    console.log(`Server: ${err instanceof ApiError ? err.message : "not reachable"}`);
  }
}

async function unpair() {
  const cfg = loadConfig();
  if (!cfg) return console.log("Not paired.");
  try {
    await call(cfg.server, "/api/companion/device/revoke", { bearer: cfg.token });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) console.log("Could not reach the server; also remove this computer on the Companion page.");
  }
  rmSync(path.join(configDir(), "config.json"), { force: true });
  console.log("Unpaired. Local move logs are kept so earlier organise tasks can still be undone after pairing again.");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  if (isElevated()) {
    console.error("Refusing to run as Administrator/root. Start the companion from a normal user terminal.");
    process.exitCode = 3;
    return;
  }
  if (cmd === "pair") return pair(args);
  if (cmd === "folders") return folders(args);
  if (cmd === "run") return runLoop(requireConfig(), { once: args.includes("--once") });
  if (cmd === "status") return status();
  if (cmd === "unpair") return unpair();
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof PathPolicyError || err instanceof ApiError || err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
