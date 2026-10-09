import type { FillResult, FormSnapshot } from "@ufa/form-engine";
import type { AttachOutcome, EmailInsertResult, FillItem, UploadField } from "@ufa/form-engine/dom";

/** Messages between the side panel and the content script. */
export type PanelToContent =
  | { type: "UFA_DETECT" }
  | { type: "UFA_HIGHLIGHT"; fieldId: string }
  | { type: "UFA_PING" }
  /** Fill fields the user confirmed (values come from the server after confirmation). */
  | { type: "UFA_FILL"; items: FillItem[]; visual?: boolean }
  | { type: "UFA_UNDO" }
  /** Put an email draft the user approved into the open compose window (never sends). */
  | { type: "UFA_INSERT_EMAIL"; subject: string; body: string }
  | { type: "UFA_UNDO_EMAIL" }
  /** Upload fields on the page, and attaching a document the user chose to one of them. */
  | { type: "UFA_LIST_UPLOADS" }
  | { type: "UFA_ATTACH_FILE"; fieldId: string; name: string; mime: string; base64: string };

export type ContentToPanel = { type: "UFA_FORM_CHANGED"; reason: "dom" | "navigation"; snapshot: FormSnapshot };

export type DetectResponse = { ok: true; snapshot: FormSnapshot } | { ok: false; error: string };
export type FillResponse = { ok: true; results: FillResult[] } | { ok: false; error: string };
export type UndoResponse = { ok: true; restored: number } | { ok: false; error: string };
export type ListUploadsResponse = { ok: true; fields: UploadField[] } | { ok: false; error: string };
export type AttachFileResponse = { ok: true; outcome: AttachOutcome } | { ok: false; error: string };
export type InsertEmailResponse = { ok: true; result: EmailInsertResult } | { ok: false; error: string };
