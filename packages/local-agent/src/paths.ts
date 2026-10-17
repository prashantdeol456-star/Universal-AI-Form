import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Path safety for the local companion. Every path is resolved with realpath (symbolic links
 * and junctions followed) and must stay inside the granted folder. System folders, credential
 * stores, browser profiles and key files are refused even inside a granted folder.
 */
const home = os.homedir();
const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

/** Folders that may never be granted (or contain a granted folder's target). */
export function protectedRoots(): string[] {
  const env = process.env;
  const list = [
    // Windows
    env.SystemRoot ?? "C:\\Windows",
    env.ProgramFiles ?? "C:\\Program Files",
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    env.ProgramData ?? "C:\\ProgramData",
    path.join(home, "AppData"),
    // Unix-like
    "/etc",
    "/bin",
    "/sbin",
    "/usr",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/var",
    "/System",
    "/Library",
    path.join(home, "Library"),
    // Credentials and keys anywhere under home
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
    path.join(home, ".mozilla"),
    path.join(home, ".password-store"),
  ];
  return list.filter(Boolean).map(norm);
}

/** File names never read, listed for content, moved or written, wherever they are. */
const SECRET_FILE = /(^|[\\/])(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|.*\.(pem|key|p12|pfx|kdbx|keychain|jks|ovpn)|login data|cookies|web data|key[34]\.db|logins\.json|cert[89]\.db)$/i;
const SECRET_DIR = /(^|[\\/])(\.git|\.ssh|\.gnupg|node_modules)([\\/]|$)/i;

export const isSecretFile = (p: string) => SECRET_FILE.test(p.replace(/[\\/]+$/, ""));
export const inSkippedDir = (p: string) => SECRET_DIR.test(p);

export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(`${p}/`);
}

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** Validates a folder the user wants to grant on this computer. Returns its real path. */
export function validateGrantRoot(input: string): string {
  if (!input || /\0/.test(input)) throw new PathPolicyError("Give a folder path");
  let real: string;
  try {
    real = realpathSync.native(path.resolve(input));
  } catch {
    throw new PathPolicyError("The folder does not exist");
  }
  const r = norm(real);
  if (r === norm(home) || r === norm(path.parse(real).root)) throw new PathPolicyError("Grant a specific folder, not your whole home folder or drive");
  for (const p of protectedRoots()) {
    if (isInside(r, p) || isInside(p, r)) throw new PathPolicyError("System, application-data and credential folders cannot be granted");
  }
  if (isSecretFile(real)) throw new PathPolicyError("This location cannot be granted");
  return real;
}

/**
 * Resolves `relative` inside the granted root. Rejects absolute paths, "..", symbolic links
 * or junctions pointing outside, and secret files. `mustExist=false` checks the parent instead
 * (for new files).
 */
export function resolveInside(root: string, relative: string, mustExist = true): string {
  if (typeof relative !== "string" || relative.length > 500 || /\0/.test(relative)) throw new PathPolicyError("Invalid path");
  if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) throw new PathPolicyError("Use a path inside the approved folder");
  const rootReal = realpathSync.native(root);
  const joined = path.resolve(rootReal, relative);
  if (!isInside(joined, rootReal)) throw new PathPolicyError("The path leaves the approved folder");
  let real: string;
  if (mustExist) {
    try {
      real = realpathSync.native(joined);
    } catch {
      throw new PathPolicyError("The file does not exist");
    }
  } else {
    let parent: string;
    try {
      parent = realpathSync.native(path.dirname(joined));
    } catch {
      throw new PathPolicyError("The destination folder does not exist");
    }
    real = path.join(parent, path.basename(joined));
  }
  if (!isInside(real, rootReal)) throw new PathPolicyError("A link points outside the approved folder");
  if (isSecretFile(real) || inSkippedDir(path.relative(rootReal, real))) throw new PathPolicyError("This file is protected (keys, credentials or repository internals)");
  return real;
}

/** A file name the companion may create: no separators, no reserved Windows names, sane length. */
export function safeFileName(name: string): string {
  const n = name.normalize("NFKC").trim();
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
  if (!n || n.length > 120 || /[\\/:*?"<>|\u0000-\u001f]/.test(n) || /^\.+$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) throw new PathPolicyError("Invalid file name");
  if (isSecretFile(n)) throw new PathPolicyError("That file name is reserved for secrets");
  return n;
}
