import { prepareValue } from "../fill";
import { cleanLabel } from "../text";
import { choiceLabelOf, liveSignature } from "./detect";
import { findFieldElement, type FillItem } from "./fill";

/**
 * Post-fill verification (AI browser Phase 2): re-reads every filled field from the page
 * and compares it with what was intended. Typing "succeeded" is not proof: frameworks
 * reset values, masks reformat them, and pages re-render.
 */
export type VerifyStatus = "verified" | "mismatch" | "missing" | "stale";

export interface VerifyResult {
  fieldId: string;
  status: VerifyStatus;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function members(el: HTMLInputElement): HTMLInputElement[] {
  if (!el.name) return [el];
  const root = el.form ?? (el.getRootNode() as Document | ShadowRoot);
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="${el.type}"][name="${el.name.replace(/["\\]/g, "\\$&")}"]`)];
}

function currentMatches(el: HTMLElement, item: FillItem, expected: string): boolean {
  const { field } = item;
  if (field.kind === "radio" || (field.kind === "checkbox" && field.options.length > 1)) {
    const hit = members(el as HTMLInputElement).find((m) => m.checked && choiceLabelOf(m) === expected);
    return Boolean(hit);
  }
  if (field.kind === "checkbox") return String((el as HTMLInputElement).checked) === expected;
  if (el.tagName === "SELECT") {
    const sel = el as HTMLSelectElement;
    const opt = sel.options[sel.selectedIndex];
    return Boolean(opt) && cleanLabel(opt!.text) === expected;
  }
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const input = el as HTMLInputElement;
    const v = input.value;
    if (input.type === "month") return v === expected.slice(0, 7);
    if (input.type === "datetime-local") return v.startsWith(expected);
    return norm(v) === norm(expected);
  }
  if (el.isContentEditable || el.getAttribute("contenteditable") !== null) return norm(el.textContent ?? "") === norm(expected);
  return false;
}

/** Checks the fields that reported "filled". Others are not re-checked (nothing was written). */
export function verifyFill(doc: Document, items: FillItem[]): VerifyResult[] {
  return items.map(({ field, instruction }) => {
    const el = findFieldElement(doc, field.id);
    if (!el) return { fieldId: field.id, status: "missing" };
    if (liveSignature(el) !== field.signature) return { fieldId: field.id, status: "stale" };
    const prepared = prepareValue(field, instruction);
    if (!prepared.ok) return { fieldId: field.id, status: "mismatch" };
    return { fieldId: field.id, status: currentMatches(el, { field, instruction }, prepared.value) ? "verified" : "mismatch" };
  });
}
