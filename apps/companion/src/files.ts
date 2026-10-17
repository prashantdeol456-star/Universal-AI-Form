import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inSkippedDir, isSecretFile, planHash, planOrganize, resolveInside, safeFileName, type FileEntry, type OrganizeBy, type PlannedMove } from "@ufa/local-agent";
import { redact } from "@ufa/security";
import type { StepReport } from "./api";
import { readState, stateFile, writeJson } from "./config";

/**
 * File actions inside an approved folder. Every path goes through resolveInside (real path,
 * no "..", no links leaving the folder, no key/credential files). Nothing is ever deleted;
 * moves never overwrite (hard link + unlink, which fails if the target exists); new files are
 * created with the exclusive flag. Each move is logged before the next one so it can be undone.
 */
export const LIST_LIMIT = 500;
const READ_LIMIT_BYTES = 10 * 1024 * 1024;

export interface ListedFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/** Files under `root` (up to 3 levels), skipping links, hidden/secret/repository files. */
export function listFiles(root: string, filter: { nameContains?: string | null; extensions?: string[] }, signal?: AbortSignal): { files: ListedFile[]; truncated: boolean } {
  const out: ListedFile[] = [];
  let truncated = false;
  const want = filter.nameContains?.toLowerCase() ?? null;
  const exts = new Set((filter.extensions ?? []).map((e) => e.toLowerCase()));
  const walk = (dir: string, rel: string, depth: number) => {
    if (signal?.aborted) throw new Error("Stopped");
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || e.name.startsWith(".") || isSecretFile(e.name) || inSkippedDir(r)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(full, r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (want && !e.name.toLowerCase().includes(want)) continue;
      if (exts.size && !exts.has(path.extname(e.name).slice(1).toLowerCase())) continue;
      if (out.length >= LIST_LIMIT) {
        truncated = true;
        return;
      }
      const st = lstatSync(full);
      out.push({ path: r, size: st.size, modifiedAt: st.mtime.toISOString() });
    }
  };
  walk(root, "", 0);
  return { files: out, truncated };
}

// ------------------------------------------------------------------ summaries

const TEXT_EXT = new Set(["txt", "md", "csv", "log", "json"]);
const DOC_EXT = new Set(["pdf", "docx"]);

async function readText(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const buf = readFileSync(file);
  if (TEXT_EXT.has(ext)) return buf.toString("utf8");
  const { detectFileType } = await import("@ufa/document-engine");
  const { extractText } = await import("@ufa/document-engine/ocr");
  const type = detectFileType(buf, path.basename(file));
  if (!type || type.kind === "image") throw new Error("Not a readable document");
  const r = await extractText(buf, type);
  return r.text;
}

/** A short summary made on this computer, without AI: the first meaningful lines, sizes, counts. */
export function extractiveSummary(text: string, max = 400): { summary: string; words: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 3);
  const words = text.split(/\s+/).filter(Boolean).length;
  let summary = "";
  for (const l of lines) {
    if (summary.length + l.length > max) break;
    summary += (summary ? " · " : "") + l;
  }
  return { summary: redact(summary || "(no text)"), words };
}

export async function summarizeFiles(root: string, input: { nameContains?: string | null; extensions?: string[]; maxFiles?: number; detail?: "short" | "detailed" }, opts: { excerpts: boolean; signal: AbortSignal }): Promise<StepReport> {
  const { files } = listFiles(root, input, opts.signal);
  const picked = files.filter((f) => TEXT_EXT.has(path.extname(f.path).slice(1).toLowerCase()) || DOC_EXT.has(path.extname(f.path).slice(1).toLowerCase())).slice(0, input.maxFiles ?? 10);
  const out: Array<{ name: string; size: number; words: number; summary: string; excerpt: string | null; error?: string }> = [];
  for (const f of picked) {
    if (opts.signal.aborted) return { outcome: "failed", message: "Stopped by the emergency stop" };
    const full = resolveInside(root, f.path);
    if (statSync(full).size > READ_LIMIT_BYTES) {
      out.push({ name: f.path, size: f.size, words: 0, summary: "", excerpt: null, error: "Larger than 10 MB; not read" });
      continue;
    }
    try {
      const text = await readText(full);
      const s = extractiveSummary(text, input.detail === "detailed" ? 1200 : 400);
      // Excerpts leave this computer only when the user allowed AI for this device.
      out.push({ name: f.path, size: f.size, words: s.words, summary: s.summary, excerpt: opts.excerpts ? redact(text.slice(0, 1500)) : null });
    } catch (err) {
      out.push({ name: f.path, size: f.size, words: 0, summary: "", excerpt: null, error: err instanceof Error && /scanned|empty|readable/i.test(err.message) ? err.message.slice(0, 120) : "Could not read this file" });
    }
  }
  return {
    outcome: "completed",
    message: `Read ${out.filter((f) => !f.error).length} of ${picked.length} file(s) on your computer`,
    result: { files: picked.length, read: out.filter((f) => !f.error).length, skipped: files.length - picked.length },
    secret: JSON.stringify({ files: out }),
  };
}

// ------------------------------------------------------------------ organise (plan → approve → apply → undo)

interface StoredPlan {
  folderId: string;
  moves: PlannedMove[];
  planSha: string;
}
interface OpLog {
  folderId: string;
  moves: Array<PlannedMove & { size: number; mtimeMs: number }>;
  undone?: boolean;
}

export function planOrganizeStep(root: string, taskId: string, folderId: string, by: OrganizeBy): StepReport {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: FileEntry[] = [];
  const existing = new Set<string>();
  for (const e of entries) {
    if (e.isSymbolicLink() || e.name.startsWith(".") || isSecretFile(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isFile()) {
      const st = lstatSync(full);
      files.push({ name: e.name, size: st.size, modifiedAt: st.mtime.toISOString() });
    } else if (e.isDirectory() && !inSkippedDir(e.name)) {
      for (const c of readdirSync(full)) existing.add(`${e.name}/${c}`);
    }
  }
  const { moves, skipped } = planOrganize(files, by, existing);
  const planSha = planHash(moves);
  writeJson(stateFile("plans", taskId), { folderId, moves, planSha } satisfies StoredPlan);
  const folders = new Set(moves.map((m) => m.to.split("/")[0]));
  return {
    outcome: "completed",
    message: moves.length ? `Planned ${moves.length} move(s) into ${folders.size} folder(s). Nothing moved yet.` : "Nothing to organise",
    result: { planSha, moveCount: moves.length, folderCount: folders.size, skipped },
    secret: JSON.stringify({ moves }),
  };
}

/** Moves without ever replacing an existing file. */
function moveNoOverwrite(from: string, to: string) {
  if (existsSync(to)) throw new Error("target exists");
  try {
    linkSync(from, to); // fails with EEXIST if the target appeared meanwhile
    unlinkSync(from);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("target exists");
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EINVAL") throw err;
    // File systems without hard links (FAT, some network drives): checked rename.
    if (existsSync(to)) throw new Error("target exists");
    renameSync(from, to);
  }
}

export function applyChanges(root: string, taskId: string, approvedSha: string, signal: AbortSignal, progress: (m: string) => void): StepReport {
  const plan = readState<StoredPlan>("plans", taskId);
  if (!plan) return { outcome: "failed", message: "The approved plan is not on this computer (was the companion reinstalled?). Nothing was moved." };
  if (!approvedSha || planHash(plan.moves) !== approvedSha || plan.planSha !== approvedSha) return { outcome: "failed", message: "The plan does not match what you approved. Nothing was moved." };
  const log: OpLog = { folderId: plan.folderId, moves: [] };
  const logFile = stateFile("oplog", taskId);
  writeJson(logFile, log);
  let skipped = 0;
  for (const [i, m] of plan.moves.entries()) {
    if (signal.aborted) {
      return { outcome: "failed", message: `Stopped after ${log.moves.length} of ${plan.moves.length} move(s). The finished moves can be undone.`, result: { moved: log.moves.length, skipped, total: plan.moves.length, stopped: true } };
    }
    try {
      // Target sub-folder: created directly inside the approved folder, and must really be inside it.
      const dirRel = path.posix.dirname(m.to);
      const dir = resolveInside(root, dirRel, false);
      if (!existsSync(dir)) mkdirSync(dir);
      if (!lstatSync(resolveInside(root, dirRel)).isDirectory()) throw new Error("not a folder");
      const from = resolveInside(root, m.from);
      const st = lstatSync(from);
      if (!st.isFile()) {
        skipped++;
        continue;
      }
      const to = resolveInside(root, m.to, false);
      moveNoOverwrite(from, to);
      log.moves.push({ ...m, size: st.size, mtimeMs: st.mtimeMs });
      writeJson(logFile, log);
    } catch {
      skipped++;
    }
    if (i % 20 === 19) progress(`Moved ${log.moves.length} of ${plan.moves.length}`);
  }
  // Verify: every logged move is in place and its source is gone.
  const bad = log.moves.filter((m) => !existsSync(path.join(root, m.to)) || existsSync(path.join(root, m.from)));
  if (bad.length) return { outcome: "uncertain", message: `${bad.length} move(s) could not be verified. Check the folder before retrying.`, result: { moved: log.moves.length, skipped, unverified: bad.length } };
  return { outcome: "completed", message: `Moved ${log.moves.length} file(s)${skipped ? `, ${skipped} skipped (changed or already there)` : ""}. Nothing was deleted.`, result: { moved: log.moves.length, skipped, total: plan.moves.length, verified: true } };
}

export function undoChanges(root: string, operationTaskId: string, folderId: string, signal: AbortSignal): StepReport {
  const log = readState<OpLog>("oplog", operationTaskId);
  if (!log || log.folderId !== folderId) return { outcome: "failed", message: "No record of that organise task on this computer for this folder. Nothing was changed." };
  if (log.undone) return { outcome: "completed", message: "Already undone earlier", result: { restored: 0, skipped: 0 } };
  let restored = 0;
  let skipped = 0;
  for (const m of [...log.moves].reverse()) {
    if (signal.aborted) return { outcome: "failed", message: `Stopped after restoring ${restored} file(s). Run undo again to continue.`, result: { restored, skipped, stopped: true } };
    try {
      const at = resolveInside(root, m.to);
      const st = lstatSync(at);
      // Only files that are still exactly what was moved.
      if (!st.isFile() || st.size !== m.size || Math.abs(st.mtimeMs - m.mtimeMs) > 2000) {
        skipped++;
        continue;
      }
      moveNoOverwrite(at, resolveInside(root, m.from, false));
      restored++;
    } catch {
      skipped++;
    }
  }
  writeJson(stateFile("oplog", operationTaskId), { ...log, undone: true });
  return { outcome: "completed", message: `Moved ${restored} file(s) back${skipped ? `; ${skipped} left where they are (changed, missing, or the original name is taken)` : ""}. Empty folders were kept.`, result: { restored, skipped } };
}

// ------------------------------------------------------------------ reports

const csvCell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formulas from file names
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeReport(sourceRoot: string, outputRoot: string, input: { fileName: string; format: "csv" | "md"; nameContains?: string | null }, approvedFileName: string): StepReport {
  const name = safeFileName(input.fileName);
  if (name !== approvedFileName) return { outcome: "failed", message: "The file name does not match what you approved. Nothing was written." };
  if (!name.toLowerCase().endsWith(`.${input.format}`)) return { outcome: "failed", message: "The file name must end with ." + input.format };
  const { files, truncated } = listFiles(sourceRoot, { nameContains: input.nameContains ?? null });
  const rows = files.map((f) => ({ name: path.posix.basename(f.path), folder: path.posix.dirname(f.path) === "." ? "" : path.posix.dirname(f.path), sizeKb: Math.round(f.size / 102.4) / 10, modified: f.modifiedAt.slice(0, 10) }));
  const content =
    input.format === "csv"
      ? ["Name,Folder,Size (KB),Modified", ...rows.map((r) => [r.name, r.folder, r.sizeKb, r.modified].map(csvCell).join(","))].join("\r\n") + "\r\n"
      : [`# File report`, "", `${rows.length} file(s)${truncated ? ` (first ${rows.length} only)` : ""}`, "", "| Name | Folder | Size (KB) | Modified |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${[r.name, r.folder, r.sizeKb, r.modified].map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n") + "\n";
  const target = resolveInside(outputRoot, name, false);
  try {
    writeFileSync(target, content, { flag: "wx" }); // never overwrite
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { outcome: "failed", message: `“${name}” already exists in that folder. Nothing was overwritten; choose another name.` };
    throw err;
  }
  const written = statSync(target).size;
  if (written !== Buffer.byteLength(content)) return { outcome: "uncertain", message: "The report was written but its size does not match. Check the file." };
  return { outcome: "completed", message: `Created “${name}” with ${rows.length} row(s)`, result: { fileName: name, rows: rows.length, bytes: written, truncated, verified: true } };
}

export function listStep(root: string, input: { nameContains?: string | null; extensions?: string[] }, signal: AbortSignal): StepReport {
  const { files, truncated } = listFiles(root, input, signal);
  return {
    outcome: "completed",
    message: `Found ${files.length}${truncated ? "+" : ""} file(s)`,
    result: { count: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0), truncated },
    secret: JSON.stringify({ files: files.slice(0, 200) }),
  };
}
