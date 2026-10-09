import { acceptsFile, suggestDocumentType, type SuggestedDocument } from "../documents";

/**
 * Upload fields on a page and attaching one of the user's own documents to them.
 * Attaching happens only after the user clicks Attach in the side panel, with the
 * file they chose; it never submits the form. Many sites hide the real
 * <input type="file"> behind a "Drop file here / Select file" box, so hidden
 * inputs are included and described by the text around them.
 */

export interface UploadField {
  id: string;
  /** What the page says about this upload ("Autofill with Resume — Drop file here or Select file"). */
  label: string;
  accept: string | null;
  multiple: boolean;
  /** Files already chosen in this field. */
  fileCount: number;
  suggested: SuggestedDocument | null;
}

export type AttachOutcome = { ok: true; fileName: string } | { ok: false; reason: "not_found" | "not_accepted" | "rejected_by_page" | "disabled" };

const ATTR = "data-ufa-file";

function allFileInputs(root: Document | ShadowRoot, out: HTMLInputElement[] = []): HTMLInputElement[] {
  out.push(...root.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  for (const el of root.querySelectorAll("*")) if (el.shadowRoot) allFileInputs(el.shadowRoot, out);
  return out;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Text that describes an upload field: its own label, else the nearest surrounding block with words in it. */
function describe(input: HTMLInputElement): string {
  const doc = input.ownerDocument;
  const own = [
    input.getAttribute("aria-label"),
    input.id ? doc.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : null,
    input.closest("label")?.textContent,
    input.title,
    input.name,
  ]
    .map(clean)
    .filter((t) => t.length > 1);
  // A real label is enough; surrounding text is only for inputs hidden behind a drop zone.
  if (own.length && own.some((t) => t !== clean(input.name))) return [...new Set(own)].join(" — ").slice(0, 200);
  const parts: string[] = [];
  let cur: Element | null = input.parentElement;
  for (let depth = 0; cur && depth < 8 && parts.join(" ").length < 120; depth++, cur = cur.parentElement) {
    const heading = cur.querySelector("h1, h2, h3, h4, legend, [role=heading]");
    const text = clean(cur.textContent).slice(0, 160);
    if (heading && !parts.includes(clean(heading.textContent))) parts.unshift(clean(heading.textContent));
    if (text && !parts.length) parts.push(text);
  }
  return [...new Set([...own, ...parts])].join(" — ").slice(0, 200) || "File upload";
}

export function listUploadFields(doc: Document): UploadField[] {
  return allFileInputs(doc)
    .filter((input) => !input.disabled)
    .map((input, i) => {
      input.setAttribute(ATTR, String(i + 1));
      const label = describe(input);
      return { id: String(i + 1), label, accept: input.getAttribute("accept"), multiple: input.multiple, fileCount: input.files?.length ?? 0, suggested: suggestDocumentType(label) };
    });
}

function findUpload(doc: Document, id: string): HTMLInputElement | null {
  return allFileInputs(doc).find((i) => i.getAttribute(ATTR) === id) ?? null;
}

/** Puts `file` into the upload field `id` the way a user's file choice would, and lets the page react. */
export function attachFile(doc: Document, id: string, file: File): AttachOutcome {
  const input = findUpload(doc, id);
  if (!input) return { ok: false, reason: "not_found" };
  if (input.disabled) return { ok: false, reason: "disabled" };
  if (!acceptsFile(input.getAttribute("accept"), file.name, file.type)) return { ok: false, reason: "not_accepted" };
  const W = doc.defaultView as (Window & typeof globalThis) | null;
  if (!W) return { ok: false, reason: "rejected_by_page" };
  const dt = new W.DataTransfer();
  dt.items.add(file);
  try {
    input.files = dt.files;
  } catch {
    return { ok: false, reason: "rejected_by_page" };
  }
  if (!input.files?.length) return { ok: false, reason: "rejected_by_page" };
  input.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new W.Event("change", { bubbles: true, composed: true }));
  return { ok: true, fileName: file.name };
}
