import { looksLikeDocx } from "./docx";

/**
 * File type detection from content ("magic bytes"). The client-supplied MIME
 * type is never trusted. Plain text has no magic bytes, so it is accepted only when
 * the file is named .txt (or stored as text/plain) AND its content is valid UTF-8 text.
 */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DetectedType {
  mime: "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | typeof DOCX_MIME | "text/plain";
  ext: "pdf" | "jpg" | "png" | "webp" | "docx" | "txt";
  kind: "pdf" | "image" | "docx" | "text";
}

export const ALLOWED_MIME_TYPES: readonly DetectedType["mime"][] = ["application/pdf", "image/jpeg", "image/png", "image/webp", DOCX_MIME, "text/plain"];

/** Accepted file name extensions and the type their content must have. */
const EXT_KIND: Record<string, DetectedType["ext"]> = { pdf: "pdf", jpg: "jpg", jpeg: "jpg", png: "png", webp: "webp", docx: "docx", txt: "txt" };

/**
 * `hint` is the original file name or the stored MIME type; it is only used to allow plain
 * text (which has no signature). Binary formats are recognised from content alone.
 */
export function detectFileType(buf: Buffer, hint?: string | null): DetectedType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf", kind: "pdf" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", ext: "png", kind: "image" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp", ext: "webp", kind: "image" };
  }
  if (looksLikeDocx(buf)) return { mime: DOCX_MIME, ext: "docx", kind: "docx" };
  const h = (hint ?? "").toLowerCase();
  if ((h.endsWith(".txt") || h === "text/plain") && decodePlainText(buf) !== null) return { mime: "text/plain", ext: "txt", kind: "text" };
  return null;
}

/** The extension in a file name when it is one we accept, e.g. "CV.DOCX" → "docx". */
export function declaredExtension(filename: string): DetectedType["ext"] | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(filename.trim());
  return m ? EXT_KIND[m[1]!.toLowerCase()] ?? null : null;
}

/**
 * UTF-8 text, or null when the bytes are not text: invalid UTF-8, NUL bytes, or more than
 * 1% control characters. A UTF-8 byte-order mark is removed; line endings become "\n".
 */
export function decodePlainText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // byte-order mark
  s = s.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex -- counting control characters is the point
  const control = (s.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) ?? []).length;
  if (s.length && control / s.length > 0.01) return null;
  return s;
}

/**
 * Rejects PDFs carrying active content. Legit marksheets/certificates never need
 * JavaScript or auto-launch actions; these are common malware vectors.
 */
export function pdfHasActiveContent(buf: Buffer): boolean {
  const s = buf.toString("latin1");
  return /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(s);
}

/** Keeps a safe display filename: no paths, control chars, or odd characters; max 120 chars. */
export function sanitizeFilename(name: string, fallbackExt: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : `document.${fallbackExt}`;
}
