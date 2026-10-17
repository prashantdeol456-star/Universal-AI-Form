import { z } from "zod";
import { CAPABILITIES, LOCAL_STEPS, type Capability, type FolderAccess } from "./capabilities";
import { COMMAND_TEMPLATES } from "./commands";

/**
 * Natural-language → structured local task plan (AI browser Phase 6, purpose `plan_task`).
 * Only the user's own request is planned: page or document text never reaches the planner,
 * so it cannot add steps. Every plan is validated against these schemas, the user's granted
 * folders and the device's capabilities before it is shown, and nothing runs until the user
 * presses Run (side effects also need their own approval inside the task).
 */
const uuid = z.uuid();
export const LOCAL_TASK_INPUTS = {
  local_summarize_files: z.object({ deviceId: uuid, folderId: uuid, nameContains: z.string().trim().max(60).nullish().transform((v) => v || null), extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(10).default([]), maxFiles: z.number().int().min(1).max(20).default(10), detail: z.enum(["short", "detailed"]).default("short") }),
  local_organize_files: z.object({ deviceId: uuid, folderId: uuid, by: z.enum(["type", "extension", "month"]).default("type") }),
  local_create_report: z.object({ deviceId: uuid, sourceFolderId: uuid, outputFolderId: uuid, format: z.enum(["csv", "md"]).default("csv"), fileName: z.string().trim().min(1).max(100).regex(/^[^\\/:*?"<>|]+$/), nameContains: z.string().trim().max(60).nullish().transform((v) => v || null) }),
  local_run_command: z.object({ deviceId: uuid, folderId: uuid, commandId: z.enum(COMMAND_TEMPLATES.map((c) => c.id) as [string, ...string[]]) }),
  local_undo_changes: z.object({ deviceId: uuid, folderId: uuid, operationTaskId: uuid }),
} as const;
export type LocalTaskType = keyof typeof LOCAL_TASK_INPUTS;
export const LOCAL_TASK_TYPES = Object.keys(LOCAL_TASK_INPUTS) as LocalTaskType[];

/** Steps of each local task type (server templates use the same list). */
export const LOCAL_TASK_STEPS: Record<LocalTaskType, Array<{ key: string; type: string; title: string; idempotent?: boolean }>> = {
  local_summarize_files: [
    { key: "list", type: "local.list_files", title: "List matching files in the approved folder" },
    { key: "summary", type: "local.summarize_files", title: "Read the files on your computer and make a short summary there" },
    { key: "ai", type: "server.summarize_local_files", title: "Improve the summary with AI (only if you allowed it for this device)" },
  ],
  local_organize_files: [
    { key: "plan", type: "local.plan_organize", title: "Work out where each file would go (nothing moves yet)" },
    { key: "approve", type: "approval.apply_local_changes", title: "Approve the moves you saw in the preview" },
    { key: "apply", type: "local.apply_changes", title: "Move the files (no deletion, no overwriting)", idempotent: false },
  ],
  local_create_report: [
    { key: "list", type: "local.list_files", title: "List the files for the report" },
    { key: "approve", type: "approval.create_local_file", title: "Approve creating the report file" },
    { key: "write", type: "local.write_report", title: "Write the report (a new file, never overwriting)", idempotent: false },
  ],
  local_run_command: [
    { key: "approve", type: "approval.run_local_command", title: "Approve running the exact command shown" },
    { key: "run", type: "local.run_command", title: "Run the command on your computer", idempotent: false },
    { key: "review", type: "server.review_command_output", title: "Explain the result" },
  ],
  local_undo_changes: [
    { key: "approve", type: "approval.undo_local_changes", title: "Approve moving the files back" },
    { key: "undo", type: "local.undo_changes", title: "Move the files back where they were", idempotent: false },
  ],
};

export interface PlanFolder {
  id: string;
  label: string;
  access: FolderAccess[];
}

export interface PlanContext {
  deviceId: string;
  capabilities: string[];
  folders: PlanFolder[];
  preferences: { reportFormat?: "csv" | "md"; outputFolderId?: string; organizeBy?: "type" | "extension" | "month"; summaryLength?: "short" | "detailed" };
  lastOrganizeTaskId?: string | null;
}

export interface LocalPlan {
  taskType: LocalTaskType;
  input: Record<string, unknown>;
  explanation: string;
  steps: string[];
  requiredCapabilities: Capability[];
  missing: string[];
}

export type PlanResult = { ok: true; plan: LocalPlan } | { ok: false; question: string };

/**
 * A file-name filter from the request ("the invoices"), unless the word only appears as the
 * folder's own name ("files in Invoices"): then every file of that folder is meant.
 */
function nameFilter(t: string, folderLabel: string, words: RegExp): string | null {
  const m = words.exec(t);
  if (!m) return null;
  const word = m[1]!.replace(/s$/, "");
  const label = folderLabel.toLowerCase();
  const inText = [...t.matchAll(new RegExp(`\\b${word}s?\\b`, "g"))].length;
  if (!label.includes(word)) return word;
  // Mentions of the folder itself: "in/from/inside Invoices", else "of Invoices", else the bare name.
  const lab = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inPrep = [...t.matchAll(new RegExp(`\\b(?:in|from|inside|within)\\s+(?:the\\s+|my\\s+)?${lab}\\b`, "g"))].length;
  const ofPrep = [...t.matchAll(new RegExp(`\\bof\\s+(?:the\\s+|my\\s+)?${lab}\\b`, "g"))].length;
  const folderMentions = inPrep || Math.min(ofPrep, 1) || 1;
  return inText > folderMentions ? word : null;
}
const FILE_WORDS = /\b(invoices?|receipts?|statements?|resumes?|cvs?|reports?|bills?)\b/;
const REPORT_FILE_WORDS = /\b(invoices?|receipts?|statements?|resumes?|cvs?|bills?)\b/;

function findFolder(text: string, folders: PlanFolder[], need: FolderAccess): PlanFolder | null | "ambiguous" {
  const t = text.toLowerCase();
  const usable = folders.filter((f) => f.access.includes(need));
  const named = usable.filter((f) => t.includes(f.label.toLowerCase()));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    const longest = named.sort((a, b) => b.label.length - a.label.length);
    return longest[0]!.label.length > longest[1]!.label.length ? longest[0]! : "ambiguous";
  }
  if (usable.length === 1) return usable[0]!;
  return usable.length ? "ambiguous" : null;
}

/** Checks a plan against the device and folders; returns the reasons it cannot run yet. */
export function missingFor(plan: { taskType: LocalTaskType; input: Record<string, unknown> }, ctx: PlanContext): string[] {
  const out: string[] = [];
  const caps = new Set<Capability>();
  for (const s of LOCAL_TASK_STEPS[plan.taskType]) {
    const spec = (LOCAL_STEPS as Record<string, { capability: Capability }>)[s.type];
    if (spec) caps.add(spec.capability);
  }
  for (const c of caps) if (!ctx.capabilities.includes(c)) out.push(`Allow “${CAPABILITIES[c].label}” for this device`);
  const need: Array<[string, FolderAccess]> =
    plan.taskType === "local_create_report"
      ? [["sourceFolderId", "read"], ["outputFolderId", "write"]]
      : [["folderId", plan.taskType === "local_run_command" ? "run" : plan.taskType === "local_summarize_files" ? "read" : "write"]];
  for (const [field, access] of need) {
    const f = ctx.folders.find((x) => x.id === plan.input[field]);
    if (!f) out.push("Choose an approved folder");
    else if (!f.access.includes(access)) out.push(`Approve “${f.label}” for ${access} on your computer (companion: folders add … --${access})`);
  }
  return out;
}

const requiredCaps = (t: LocalTaskType): Capability[] => [...new Set(LOCAL_TASK_STEPS[t].map((s) => (LOCAL_STEPS as Record<string, { capability: Capability }>)[s.type]?.capability).filter((x): x is Capability => Boolean(x)))];

function finish(taskType: LocalTaskType, input: Record<string, unknown>, explanation: string, ctx: PlanContext): PlanResult {
  const parsed = LOCAL_TASK_INPUTS[taskType].safeParse(input);
  if (!parsed.success) return { ok: false, question: "I could not build a valid plan from that. Say which approved folder to use." };
  const plan = { taskType, input: parsed.data as Record<string, unknown> };
  return { ok: true, plan: { ...plan, explanation, steps: LOCAL_TASK_STEPS[taskType].map((s) => s.title), requiredCapabilities: requiredCaps(taskType), missing: missingFor(plan, ctx) } };
}

/** Deterministic planner for the supported requests. Returns a clarifying question when unsure. */
export function planLocalTask(request: string, ctx: PlanContext): PlanResult {
  const t = request.toLowerCase().replace(/\s+/g, " ").trim();
  if (t.length < 3) return { ok: false, question: "What should I do on your computer?" };
  const folderOr = (need: FolderAccess): { q: string } | { f: PlanFolder } => {
    const f = findFolder(t, ctx.folders, need);
    return f === "ambiguous" ? { q: `Which folder? You approved: ${ctx.folders.filter((x) => x.access.includes(need)).map((x) => `“${x.label}”`).join(", ")}.` } : f ? { f } : { q: `No folder is approved for ${need} yet. On your computer run: companion folders add "<folder>" --${need}` };
  };
  const exts = [...new Set([...t.matchAll(/\b(pdf|docx|txt|csv|xlsx|jpg|png)s?\b/g)].map((m) => m[1]!))];

  if (/\b(undo|revert|put (them|it) back)\b/.test(t)) {
    if (!ctx.lastOrganizeTaskId) return { ok: false, question: "There is no completed organise task to undo." };
    const r = folderOr("write");
    if ("q" in r) return { ok: false, question: r.q };
    return finish("local_undo_changes", { deviceId: ctx.deviceId, folderId: r.f.id, operationTaskId: ctx.lastOrganizeTaskId }, `Move the files of your last organise task back in “${r.f.label}”.`, ctx);
  }
  if (/\b(run|execute|start)\b.*\b(tests?|lint|typecheck|type check|build)\b|\bgit (status|diff)\b/.test(t)) {
    const commandId = /\bgit diff\b/.test(t) ? "git_diff_stat" : /\bgit status\b/.test(t) ? "git_status" : /\blint\b/.test(t) ? "npm_lint" : /\btype ?check\b/.test(t) ? "npm_typecheck" : /\bbuild\b/.test(t) ? "npm_build" : /\bpytest|python\b/.test(t) ? "pytest" : "npm_test";
    const r = folderOr("run");
    if ("q" in r) return { ok: false, question: r.q };
    const c = COMMAND_TEMPLATES.find((x) => x.id === commandId)!;
    return finish("local_run_command", { deviceId: ctx.deviceId, folderId: r.f.id, commandId }, `Run “${c.label}” in “${r.f.label}” after you approve it, then explain the result.`, ctx);
  }
  if (/\b(organi[sz]e|sort|arrange|tidy|group)\b/.test(t)) {
    const by = /\b(month|date)\b/.test(t) ? "month" : /\bextension\b/.test(t) ? "extension" : /\btype\b/.test(t) ? "type" : ctx.preferences.organizeBy ?? "type";
    const r = folderOr("write");
    if ("q" in r) return { ok: false, question: r.q };
    return finish("local_organize_files", { deviceId: ctx.deviceId, folderId: r.f.id, by }, `Preview how the files in “${r.f.label}” would be grouped by ${by}; nothing moves until you approve.`, ctx);
  }
  if (/\b(report|excel|spreadsheet|csv|inventory|list (of|all) (the )?files)\b/.test(t)) {
    const src = folderOr("read");
    if ("q" in src) return { ok: false, question: src.q };
    const outId = ctx.preferences.outputFolderId && ctx.folders.some((f) => f.id === ctx.preferences.outputFolderId && f.access.includes("write")) ? ctx.preferences.outputFolderId : null;
    const out: { q: string } | { f: PlanFolder } = outId ? { f: ctx.folders.find((f) => f.id === outId)! } : folderOr("write");
    if ("q" in out) return { ok: false, question: out.q.replace("Which folder?", "Which folder should the report go to?") };
    const format = /\b(excel|csv|spreadsheet)\b/.test(t) ? "csv" : /\bmarkdown|\.md\b/.test(t) ? "md" : ctx.preferences.reportFormat ?? "csv";
    const stamp = new Date().toISOString().slice(0, 10);
    // Here "report" is the action, not a file-name filter ("a report of the invoices").
    const reportKeyword = nameFilter(t, src.f.label, REPORT_FILE_WORDS);
    return finish("local_create_report", { deviceId: ctx.deviceId, sourceFolderId: src.f.id, outputFolderId: out.f.id, format, fileName: `report-${stamp}.${format}`, nameContains: reportKeyword }, `List the ${reportKeyword ?? ""} files in “${src.f.label}” and write a ${format.toUpperCase()} report into “${out.f.label}” after you approve.`.replace("  ", " "), ctx);
  }
  if (/\b(summar|what('s| is) in|read|explain|review)\w*/.test(t) && /\b(files?|pdfs?|docs?|documents?|folder|invoices?|receipts?|reports?|notes?)\b/.test(t)) {
    const r = folderOr("read");
    if ("q" in r) return { ok: false, question: r.q };
    const keyword = nameFilter(t, r.f.label, FILE_WORDS);
    return finish("local_summarize_files", { deviceId: ctx.deviceId, folderId: r.f.id, nameContains: keyword, extensions: exts.length ? exts : [], maxFiles: 10, detail: /\b(detail(ed)?|longer|in depth)\b/.test(t) ? "detailed" : ctx.preferences.summaryLength ?? "short" }, `Read up to 10 ${exts.length ? exts.join("/").toUpperCase() + " " : ""}${keyword ? `“${keyword}” ` : ""}files in “${r.f.label}” on your computer and summarise them.`, ctx);
  }
  return { ok: false, question: "I can summarise files, organise a folder, write a file report, run an approved project command (tests, lint, build, git status) or undo an organise. Which one do you want?" };
}

/** Validates a plan proposed by a model: known task type, valid input, and only the user's folders/device. */
export function validateModelPlan(raw: unknown, ctx: PlanContext): PlanResult {
  const p = z.object({ task_type: z.enum(LOCAL_TASK_TYPES as [LocalTaskType, ...LocalTaskType[]]), input: z.record(z.string(), z.unknown()), explanation: z.string().max(300) }).safeParse(raw);
  if (!p.success) return { ok: false, question: "I could not understand that request. Try: “summarise the PDFs in Invoices”." };
  const input: Record<string, unknown> = { ...p.data.input, deviceId: ctx.deviceId };
  for (const k of ["folderId", "sourceFolderId", "outputFolderId"]) {
    if (k in input && !ctx.folders.some((f) => f.id === input[k])) return { ok: false, question: "The plan referred to a folder you have not approved." };
  }
  return finish(p.data.task_type, input, p.data.explanation, ctx);
}
