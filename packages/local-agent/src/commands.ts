/**
 * Allowlisted commands for the local companion (AI browser Phase 6). There is no shell and
 * no free-form command: a task names a template id, the companion runs that exact program
 * with fixed arguments (no user, page, document or AI text is ever interpolated), in a folder
 * granted on the computer with "run" access, with a timeout and an output cap.
 */
export interface CommandTemplate {
  id: string;
  label: string;
  program: "npm" | "npx" | "node" | "git" | "python";
  args: readonly string[];
  /** Shown to the user; every template is approved per run anyway. */
  effects: "reads_project" | "writes_project";
  timeoutMs: number;
  /** A file that must exist in the folder for the command to make sense. */
  requires: string | null;
}

export const COMMAND_TEMPLATES: readonly CommandTemplate[] = [
  { id: "npm_test", label: "npm test", program: "npm", args: ["test"], effects: "reads_project", timeoutMs: 10 * 60_000, requires: "package.json" },
  { id: "npm_lint", label: "npm run lint", program: "npm", args: ["run", "lint"], effects: "reads_project", timeoutMs: 5 * 60_000, requires: "package.json" },
  { id: "npm_typecheck", label: "npm run typecheck", program: "npm", args: ["run", "typecheck"], effects: "reads_project", timeoutMs: 5 * 60_000, requires: "package.json" },
  { id: "npm_build", label: "npm run build", program: "npm", args: ["run", "build"], effects: "writes_project", timeoutMs: 15 * 60_000, requires: "package.json" },
  { id: "git_status", label: "git status --short", program: "git", args: ["status", "--short"], effects: "reads_project", timeoutMs: 60_000, requires: ".git" },
  { id: "git_diff_stat", label: "git diff --stat", program: "git", args: ["diff", "--stat"], effects: "reads_project", timeoutMs: 60_000, requires: ".git" },
  { id: "pytest", label: "python -m pytest -q", program: "python", args: ["-m", "pytest", "-q"], effects: "reads_project", timeoutMs: 10 * 60_000, requires: null },
];

export const OUTPUT_LIMIT = 64 * 1024;

export function commandTemplate(id: string): CommandTemplate | null {
  return COMMAND_TEMPLATES.find((c) => c.id === id) ?? null;
}

/** Environment for a command: no tokens or secrets of the companion, CI-style non-interactive. */
export function commandEnv(base: Record<string, string | undefined>): Record<string, string> {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ComSpec", "LANG", "TERM", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "windir"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

/** Keeps the start and the end of long output (errors are usually at the end). */
export function capOutput(s: string, limit = OUTPUT_LIMIT): { text: string; truncated: boolean } {
  if (s.length <= limit) return { text: s, truncated: false };
  const half = Math.floor(limit / 2);
  return { text: `${s.slice(0, half)}\n… [${s.length - limit} characters cut] …\n${s.slice(-half)}`, truncated: true };
}
