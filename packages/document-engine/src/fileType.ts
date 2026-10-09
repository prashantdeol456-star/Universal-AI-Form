/**
 * File type detection from content ("magic bytes"). The client-supplied MIME
 * type and file extension are never trusted.
 */
export interface DetectedType {
  mime: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  ext: "pdf" | "jpg" | "png" | "webp";
  kind: "pdf" | "image";
}

export const ALLOWED_MIME_TYPES: readonly DetectedType["mime"][] = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

export function detectFileType(buf: Buffer): DetectedType | null {
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
  return null;
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
