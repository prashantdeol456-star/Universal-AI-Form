import { inflateRawSync } from "node:zlib";

/**
 * DOCX reading without third-party code (AI browser Phase 3). A .docx file is a ZIP
 * archive; only `word/document.xml` is read, as text. Nothing in the file is executed:
 * macro-enabled documents are rejected, embedded objects, scripts, fields and external
 * relationships are ignored, and no XML DTD or entity is ever resolved.
 *
 * Every size is bounded before anything is inflated (ZIP bombs).
 */
export const DOCX_LIMITS = {
  maxEntries: 2_000,
  /** Uncompressed size of word/document.xml. */
  maxDocumentXmlBytes: 25 * 1024 * 1024,
  /** Uncompressed bytes the archive claims in total. */
  maxTotalUncompressed: 200 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const;

export class DocxError extends Error {
  constructor(
    public readonly code: "corrupt" | "macro" | "too_large" | "not_docx",
    message: string,
  ) {
    super(message);
    this.name = "DocxError";
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Central directory of a ZIP archive (no ZIP64, no encryption: neither is used by Word for normal documents). */
export function zipEntries(buf: Buffer): ZipEntry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError("corrupt", "The file is damaged (no ZIP directory)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new DocxError("too_large", "Very large (ZIP64) documents are not supported");
  if (count > DOCX_LIMITS.maxEntries) throw new DocxError("too_large", "The document has too many parts");
  if (cdOffset + cdSize > buf.length) throw new DocxError("corrupt", "The file is damaged (bad ZIP directory)");

  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new DocxError("corrupt", "The file is damaged (bad ZIP entry)");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (flags & 0x1) throw new DocxError("corrupt", "Password-protected documents are not supported");
    out.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const total = out.reduce((s, e) => s + e.size, 0);
  if (total > DOCX_LIMITS.maxTotalUncompressed) throw new DocxError("too_large", "The document is too large when unpacked");
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  if (e.size > maxBytes) throw new DocxError("too_large", "The document text is too large");
  if (e.compressedSize > 0 && e.size / e.compressedSize > DOCX_LIMITS.maxCompressionRatio) throw new DocxError("too_large", "The document is suspiciously compressed");
  const h = e.localOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new DocxError("corrupt", "The file is damaged (bad ZIP header)");
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new DocxError("corrupt", "The file is damaged (truncated)");
  if (e.method === 0) return Buffer.from(data);
  if (e.method !== 8) throw new DocxError("corrupt", "Unsupported compression in the document");
  try {
    // maxOutputLength stops a lying size header from inflating without bound.
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    throw new DocxError("corrupt", "The document could not be unpacked");
  }
}

/** A ZIP whose parts say "Word document" (used by file-type detection). */
export function looksLikeDocx(buf: Buffer): boolean {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return false;
  try {
    return zipEntries(buf).some((e) => e.name === "word/document.xml");
  } catch {
    return false;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? "";
  });
}

export interface DocxText {
  /** Paragraphs in order; headings start with "# " (Heading1) or "## " (Heading2+). Table cells are joined with " | ". */
  text: string;
  paragraphs: number;
}

/** Reads the visible text of a .docx. Throws DocxError for macro-enabled, damaged or oversized files. */
export function docxText(buf: Buffer): DocxText {
  const entries = zipEntries(buf);
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if ([...names].some((n) => n.endsWith("vbaproject.bin") || n.endsWith("vbadata.xml"))) {
    throw new DocxError("macro", "Documents with macros (.docm) are not accepted");
  }
  const types = entries.find((e) => e.name === "[Content_Types].xml");
  if (types) {
    const ct = readEntry(buf, types, 1024 * 1024).toString("utf8");
    if (/macroEnabled/i.test(ct)) throw new DocxError("macro", "Documents with macros (.docm) are not accepted");
  }
  const main = entries.find((e) => e.name === "word/document.xml");
  if (!main) throw new DocxError("not_docx", "This is not a Word (.docx) document");
  const xml = readEntry(buf, main, DOCX_LIMITS.maxDocumentXmlBytes).toString("utf8");

  const body = xml.replace(/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, ""); // field codes and deleted text are not content
  const lines: string[] = [];
  // Tables: each row becomes one line with cells separated by " | ".
  const withRows = body.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => paragraphsOf(c[0]).join(" ").trim());
    return `<w:p><w:r><w:t>${cells.filter(Boolean).join(" | ").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`;
  });
  for (const p of withRows.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const t = paragraphText(p[0]);
    if (!t.trim()) continue;
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(p[0])?.[1] ?? "";
    const level = /^(heading\s*1|title)$/i.test(style) ? 1 : /^heading\s*[2-9]$/i.test(style) ? 2 : 0;
    lines.push(level === 1 ? `# ${t.trim()}` : level === 2 ? `## ${t.trim()}` : t.trim());
  }
  return { text: lines.join("\n"), paragraphs: lines.length };
}

function paragraphsOf(xml: string): string[] {
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]));
}

function paragraphText(p: string): string {
  let out = "";
  for (const m of p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else out += m[2] === "tab" ? "\t" : "\n";
  }
  return out;
}
