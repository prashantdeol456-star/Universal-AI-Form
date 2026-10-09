import type { NormalizedField } from "./types";

/**
 * Environment-independent part of form filling (spec §31–33): turns a confirmed
 * profile value into exactly what a given field accepts, or explains why it
 * cannot be filled. Never truncates or "guesses" — a field that would need a
 * changed value is skipped and left to the user.
 */

/** What kind of value the server sent (from the profile catalog). */
export type FillValueType = "text" | "date" | "number" | "select" | "yes_no" | "textarea";

/** One confirmed item the content script should fill. */
export interface FillInstruction {
  fieldId: string;
  /** Canonical value (dates as YYYY-MM-DD). For choice fields: the option label to pick. */
  value: string;
  valueType: FillValueType;
  /** Option label of the field matched on the server (select / radio / combobox). */
  option: string | null;
  /** Replace a value that is already on the page (the user explicitly allowed it). */
  overwrite: boolean;
}

export type FillReason =
  | "manual_field" // CAPTCHA / OTP / password: never automated
  | "not_fillable" // file upload or a control we do not write to
  | "no_option" // value is not one of the field's choices
  | "too_long"
  | "pattern_mismatch"
  | "invalid_email"
  | "invalid_number"
  | "invalid_date"
  | "not_found" // element is gone (page changed)
  | "hidden"
  | "disabled"
  | "has_value" // page already has a value and overwrite was not allowed
  | "rejected_by_page" // page script cleared or refused the value
  | "option_not_found" // custom dropdown did not show the option
  | "error";

export type FillStatus = "filled" | "skipped" | "failed";

export interface FillResult {
  fieldId: string;
  status: FillStatus;
  reason?: FillReason;
}

export type PreparedValue = { ok: true; value: string } | { ok: false; reason: FillReason };

const CHOICE_KINDS = new Set(["select", "radio", "combobox"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateFormat = "iso" | "dd/mm/yyyy" | "dd-mm-yyyy" | "dd.mm.yyyy" | "mm/dd/yyyy";

/** Date format a text field expects, from its placeholder / hint / pattern / label. Indian default: DD/MM/YYYY. */
export function dateFormatFor(field: Pick<NormalizedField, "kind" | "placeholder" | "hint" | "label" | "pattern">): DateFormat {
  if (field.kind === "date") return "iso";
  const text = `${field.placeholder ?? ""} ${field.hint ?? ""} ${field.label}`.toLowerCase();
  if (/yyyy\s*-\s*mm\s*-\s*dd/.test(text)) return "iso";
  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(text)) return "mm/dd/yyyy";
  if (/dd\s*-\s*mm\s*-\s*yyyy/.test(text)) return "dd-mm-yyyy";
  if (/dd\s*\.\s*mm\s*\.\s*yyyy/.test(text)) return "dd.mm.yyyy";
  if (field.pattern && /^\^?\\d\{4\}-/.test(field.pattern)) return "iso";
  return "dd/mm/yyyy";
}

export function formatDate(iso: string, format: DateFormat): string | null {
  const m = ISO_DATE.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  switch (format) {
    case "iso":
      return `${y}-${mo}-${d}`;
    case "dd/mm/yyyy":
      return `${d}/${mo}/${y}`;
    case "dd-mm-yyyy":
      return `${d}-${mo}-${y}`;
    case "dd.mm.yyyy":
      return `${d}.${mo}.${y}`;
    case "mm/dd/yyyy":
      return `${mo}/${d}/${y}`;
  }
}

/** HTML `pattern` semantics: the whole value must match. Invalid patterns are ignored (browsers ignore them too). */
export function matchesPattern(value: string, pattern: string | null): boolean {
  if (!pattern) return true;
  for (const flags of ["v", "u"]) {
    try {
      return new RegExp(`^(?:${pattern})$`, flags).test(value);
    } catch {
      // try the next flag set; older engines lack "v"
    }
  }
  return true;
}

/**
 * Value to write into `field`, or why it must be left to the user. Pure
 * function: the DOM filler only writes what this returns.
 */
export function prepareValue(field: NormalizedField, ins: Pick<FillInstruction, "value" | "valueType" | "option">): PreparedValue {
  if (field.manual) return { ok: false, reason: "manual_field" };
  if (field.kind === "file" || field.kind === "password") return { ok: false, reason: "not_fillable" };

  const raw = ins.value.trim();

  // Choice fields: only one of the page's own options, chosen on the server.
  if (CHOICE_KINDS.has(field.kind) && field.options.length > 0) {
    const opt = ins.option && field.options.find((o) => o === ins.option);
    return opt ? { ok: true, value: opt } : { ok: false, reason: "no_option" };
  }
  if (field.kind === "checkbox") {
    if (field.options.length > 1) {
      const opt = ins.option && field.options.find((o) => o === ins.option);
      return opt ? { ok: true, value: opt } : { ok: false, reason: "no_option" };
    }
    if (ins.valueType !== "yes_no" || !/^(yes|no)$/i.test(raw)) return { ok: false, reason: "not_fillable" };
    return { ok: true, value: /^yes$/i.test(raw) ? "true" : "false" };
  }

  let value = raw;
  if (ins.valueType === "date" || field.kind === "date") {
    const formatted = formatDate(raw, dateFormatFor(field));
    if (!formatted) return { ok: false, reason: "invalid_date" };
    value = formatted;
  }
  if (field.kind === "email" && !EMAIL.test(value)) return { ok: false, reason: "invalid_email" };
  if (field.kind === "number" && !NUMBER.test(value)) return { ok: false, reason: "invalid_number" };
  if (!value) return { ok: false, reason: "not_fillable" };
  if (field.maxLength && [...value].length > field.maxLength) return { ok: false, reason: "too_long" };
  if (field.kind !== "textarea" && field.kind !== "contenteditable" && !matchesPattern(value, field.pattern)) {
    return { ok: false, reason: "pattern_mismatch" };
  }
  return { ok: true, value };
}

/** Plain-language explanation for the side panel. */
export const FILL_REASON_TEXT: Record<FillReason, string> = {
  manual_field: "Must be done by you (CAPTCHA / OTP / password)",
  not_fillable: "This kind of field is not filled automatically",
  no_option: "Your value is not one of the choices",
  too_long: "Your value is longer than the field allows",
  pattern_mismatch: "The page expects a different format",
  invalid_email: "Not a valid email address",
  invalid_number: "Not a number",
  invalid_date: "Date could not be converted",
  not_found: "Field is no longer on the page",
  hidden: "Field is hidden right now",
  disabled: "Field is disabled or read-only",
  has_value: "Already has a value on the page (not replaced)",
  rejected_by_page: "The page did not accept the value",
  option_not_found: "The choice did not appear in the list",
  error: "Could not fill this field",
};
