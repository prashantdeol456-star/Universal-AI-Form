import type { LocalTaskType } from "./plan";

/**
 * Multi-agent missions (AI browser Phase 8). A mission is one request split into ordered
 * parts; each part goes to a specialised agent on one or more paired computers:
 *
 *   Planner  — splits the request and picks computers (here; rules, then the per-part planner)
 *   File     — summarise / organise / report / undo on a computer (companion file actions)
 *   Command  — allowlisted project commands on a computer
 *   Reviewer — reads the results of all parts and writes one review (server, no side effects)
 *
 * Agents have no powers of their own: every part becomes a normal computer task with the
 * device's capabilities, its approved folders and its own approvals. Parts run in order;
 * a part addressed to "all computers" runs on each of them in parallel.
 */
export const AGENTS = {
  planner: { label: "Planner agent", does: "Splits your request into steps and picks the computers" },
  file: { label: "File agent", does: "Summarises, organises and reports on files in approved folders" },
  command: { label: "Command agent", does: "Runs allowlisted project commands after your approval" },
  reviewer: { label: "Reviewer agent", does: "Checks every result and writes one review" },
} as const;
export type AgentId = keyof typeof AGENTS;
export type WorkerAgent = "file" | "command";

export const agentFor = (t: LocalTaskType): WorkerAgent => (t === "local_run_command" ? "command" : "file");

export const MISSION_LIMITS = { parts: 6, subtasks: 20 } as const;

/** Splits a request into ordered parts at "then", ";", new lines, "aur phir", "after that". */
export function splitRequest(request: string): string[] {
  return request
    .split(/\s*(?:;|\r?\n|,?\s+(?:and\s+)?then\s+|,?\s+after that\s+|,?\s+(?:aur\s+)?phir\s+|,?\s+and also\s+)\s*/i)
    .map((p) => p.replace(/^(and|aur|then|phir)\s+/i, "").trim())
    .filter((p) => p.length >= 3);
}

export interface MissionDevice {
  id: string;
  name: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALL = /\b(?:on|in|across)\s+(?:all|every|each)\s+(?:my\s+)?(?:computers?|devices?|pcs?|machines?)\b|\b(?:sab|sabhi|har)\s+(?:computers?|devices?|pcs?)\s*(?:par|pe|me|mein)?\b/i;

/**
 * Which computers a part is for: "on all computers" → every given device; "on <name>" /
 * "<name> par" → that device; otherwise the default device. Returns the text without the
 * device phrase, so folder names are matched on what remains.
 */
export function targetDevices(part: string, devices: MissionDevice[], defaultId: string | null): { text: string; deviceIds: string[] } | { question: string } {
  if (ALL.test(part)) return { text: part.replace(ALL, " ").replace(/\s+/g, " ").trim(), deviceIds: devices.map((d) => d.id) };
  // Longest names first, so "Office PC 2" wins over "Office PC".
  for (const d of [...devices].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`\\b(?:on|in|at)\\s+(?:the\\s+|my\\s+)?${esc(d.name)}\\b|\\b${esc(d.name)}\\s+(?:par|pe|me|mein)\\b`, "i");
    if (re.test(part)) return { text: part.replace(re, " ").replace(/\s+/g, " ").trim(), deviceIds: [d.id] };
  }
  if (defaultId && devices.some((d) => d.id === defaultId)) return { text: part, deviceIds: [defaultId] };
  if (devices.length === 1) return { text: part, deviceIds: [devices[0]!.id] };
  return { question: `Which computer for “${part.slice(0, 80)}”? Say “on ${devices[0]?.name ?? "<name>"}” or “on all computers”.` };
}
