/**
 * Normalized, privacy-preserving description of a web form (spec §21).
 * Contains structure only — labels, types, options — never the values the user
 * typed, and never the page's HTML.
 */
export type FieldKind =
  | "text"
  | "textarea"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "password"
  | "combobox" // custom / searchable dropdowns (role=combobox, aria-autocomplete, datalist)
  | "contenteditable";

/** Why a field must be handled by a human (spec §64): never automated. */
/** Fields the assistant never fills: the user does them (payment: card / CVV / UPI PIN; suspicious: label tries to instruct an AI). */
export type ManualReason = "captcha" | "otp" | "password" | "payment" | "suspicious" | "unsupported_control";

export interface NormalizedField {
  /** Stable within one page load (also set as data-ufa-id on the element). */
  id: string;
  kind: FieldKind;
  label: string;
  /** Where the label came from — helps the mapping engine weigh evidence. */
  labelSource: "label" | "aria" | "title" | "placeholder" | "nearby" | "table" | "legend" | "name";
  name: string | null;
  htmlId: string | null;
  placeholder: string | null;
  section: string | null;
  required: boolean;
  /** Option labels for select / radio / checkbox groups / datalist. */
  options: string[];
  autocomplete: string | null;
  inputMode: string | null;
  maxLength: number | null;
  pattern: string | null;
  /** Text of an associated validation/help message, if any. */
  hint: string | null;
  language: "en" | "hi" | "mixed";
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** True if the field currently has a value (the value itself is never captured). */
  hasValue: boolean;
  manual: ManualReason | null;
  /** For file inputs: accepted types, e.g. ".jpg,.png". */
  accept: string | null;
  /** Hash of kind + name/id + normalized label: identifies "the same field" across visits. */
  signature: string;
  frame: "top" | "child";
  inShadowDom: boolean;
}

export interface FormSnapshot {
  /** origin + pathname only — query strings can carry tokens and are dropped. */
  url: string;
  domain: string;
  pageTitle: string;
  /** Main heading / form title, if one is found. */
  formTitle: string | null;
  fields: NormalizedField[];
  sections: string[];
  /** Hash of the sorted field signatures: identifies the form (spec §58). */
  formSignature: string;
  /** Coarse DOM-structure hash: changes when the layout changes (spec §59). */
  structureHash: string;
  warnings: FormWarning[];
  detectedAt: string;
}

export type FormWarning =
  | { code: "cross_origin_iframes"; count: number }
  | { code: "closed_or_canvas_content" }
  | { code: "captcha_present" }
  | { code: "otp_present" }
  | { code: "no_fields" }
  | { code: "too_many_fields"; limit: number };
