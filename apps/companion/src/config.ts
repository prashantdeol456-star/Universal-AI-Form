import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FolderGrant } from "@ufa/local-agent";

/**
 * Companion settings on this computer: server address, device token, approved folders. Stored
 * in the user's own profile (Windows: %APPDATA%\ufa-companion, others: ~/.config/ufa-companion)
 * with owner-only permissions where the OS supports them. The token is never printed.
 */
export interface CompanionConfig {
  server: string;
  deviceId: string;
  token: string;
  name: string;
  folders: FolderGrant[];
}

export function configDir(): string {
  if (process.env.UFA_COMPANION_HOME) return path.resolve(process.env.UFA_COMPANION_HOME);
  const base = process.platform === "win32" ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(base, "ufa-companion");
}

const file = () => path.join(configDir(), "config.json");

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadConfig(): CompanionConfig | null {
  if (!existsSync(file())) return null;
  return JSON.parse(readFileSync(file(), "utf8")) as CompanionConfig;
}

export function requireConfig(): CompanionConfig {
  const c = loadConfig();
  if (!c) throw new Error("This computer is not paired yet. Run: ufa-companion pair --server https://your-server");
  return c;
}

/** Atomic write (temp file + rename), owner-only mode. */
export function writeJson(target: string, data: unknown) {
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows: the profile folder is already private to the user.
  }
}

export const saveConfig = (c: CompanionConfig) => writeJson(file(), c);

/** Per-task local state (organise plans, move logs for undo). Never sent to the server. */
export const stateFile = (kind: "plans" | "oplog", taskId: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("Invalid task id");
  return path.join(configDir(), kind, `${taskId}.json`);
};

export function readState<T>(kind: "plans" | "oplog", taskId: string): T | null {
  const f = stateFile(kind, taskId);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
}

/** Only https, except for a server on this computer (development). */
export function checkServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error("Give the server address, like https://forms.example.com");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("The server address must start with https://");
  if (u.username || u.password) throw new Error("The server address must not contain a user name or password");
  return u.origin;
}
