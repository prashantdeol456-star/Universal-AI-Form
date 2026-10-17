import { createHash } from "node:crypto";
import path from "node:path";

/**
 * File organising plans (AI browser Phase 6). A plan is computed and shown before anything
 * moves; it never deletes, never overwrites (a clash gets " (2)" etc.), and only moves files
 * that sit directly in the chosen folder (no recursion into existing sub-folders).
 */
export const ORGANIZE_LIMITS = { files: 1_000 } as const;
export type OrganizeBy = "type" | "extension" | "month";

const TYPE_FOLDERS: Array<[RegExp, string]> = [
  [/\.(pdf|docx?|odt|rtf|txt|md)$/i, "Documents"],
  [/\.(xlsx?|ods|csv)$/i, "Spreadsheets"],
  [/\.(pptx?|odp|key)$/i, "Presentations"],
  [/\.(jpe?g|png|gif|webp|heic|bmp|tiff?|svg)$/i, "Images"],
  [/\.(mp4|mov|mkv|avi|webm)$/i, "Videos"],
  [/\.(mp3|wav|m4a|aac|flac|ogg)$/i, "Audio"],
  [/\.(zip|rar|7z|tar|gz|tgz)$/i, "Archives"],
  [/\.(exe|msi|dmg|pkg|deb|rpm|apk|bat|cmd|ps1|sh)$/i, "Installers and scripts (not opened)"],
];

/** Deterministic file classification by name (no AI, no file content). */
export function classifyFile(name: string): string {
  return TYPE_FOLDERS.find(([re]) => re.test(name))?.[1] ?? "Other";
}

export interface FileEntry {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface PlannedMove {
  from: string;
  to: string;
}

export function planOrganize(files: FileEntry[], by: OrganizeBy, existing: ReadonlySet<string> = new Set()): { moves: PlannedMove[]; skipped: number } {
  const taken = new Set([...existing].map((x) => x.toLowerCase()));
  const moves: PlannedMove[] = [];
  let skipped = 0;
  for (const f of files.slice(0, ORGANIZE_LIMITS.files).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder =
      by === "type" ? classifyFile(f.name) : by === "extension" ? (path.extname(f.name).slice(1).toLowerCase() || "no-extension") : /^\d{4}-\d{2}/.test(f.modifiedAt) ? f.modifiedAt.slice(0, 7) : "unknown-date";
    let target = path.posix.join(folder, f.name);
    const ext = path.extname(f.name);
    const stem = f.name.slice(0, f.name.length - ext.length);
    for (let n = 2; taken.has(target.toLowerCase()); n++) target = path.posix.join(folder, `${stem} (${n})${ext}`);
    taken.add(target.toLowerCase());
    moves.push({ from: f.name, to: target });
  }
  skipped = Math.max(0, files.length - ORGANIZE_LIMITS.files);
  return { moves, skipped };
}

/** Stable hash of a plan, used to bind the approval to exactly these moves. */
export function planHash(moves: PlannedMove[]): string {
  return createHash("sha256").update(JSON.stringify(moves.map((m) => [m.from, m.to]))).digest("hex");
}
