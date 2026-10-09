import { z } from "zod";

import { MAX_FIELDS } from "./limits";

/** Server-side validation of snapshots sent by the extension (never trust the client). */
export { MAX_FIELDS };

const shortText = (max: number) => z.string().max(max);

export const normalizedFieldSchema = z.object({
  id: shortText(40),
  kind: z.enum(["text", "textarea", "email", "tel", "number", "date", "select", "radio", "checkbox", "file", "password", "combobox", "contenteditable"]),
  label: shortText(200),
  labelSource: z.enum(["label", "aria", "title", "placeholder", "nearby", "table", "legend", "name"]),
  name: shortText(200).nullable(),
  htmlId: shortText(200).nullable(),
  placeholder: shortText(200).nullable(),
  section: shortText(200).nullable(),
  required: z.boolean(),
  options: z.array(shortText(200)).max(400),
  autocomplete: shortText(100).nullable(),
  inputMode: shortText(30).nullable(),
  maxLength: z.number().int().min(-1).max(1_000_000).nullable(),
  pattern: shortText(300).nullable(),
  hint: shortText(300).nullable(),
  language: z.enum(["en", "hi", "mixed"]),
  visible: z.boolean(),
  disabled: z.boolean(),
  readOnly: z.boolean(),
  hasValue: z.boolean(),
  manual: z.enum(["captcha", "otp", "password", "unsupported_control"]).nullable(),
  accept: shortText(200).nullable(),
  signature: z.string().regex(/^[0-9a-f]{8}$/),
  frame: z.enum(["top", "child"]),
  inShadowDom: z.boolean(),
});

export const formSnapshotSchema = z.object({
  url: z.url().max(2000),
  domain: shortText(255),
  pageTitle: shortText(300),
  formTitle: shortText(300).nullable(),
  fields: z.array(normalizedFieldSchema).max(MAX_FIELDS),
  sections: z.array(shortText(200)).max(200),
  formSignature: z.string().regex(/^[0-9a-f]{8}$/),
  structureHash: z.string().regex(/^[0-9a-f]{8}$/),
  warnings: z.array(z.object({ code: z.string().max(40) }).loose()).max(20),
  detectedAt: z.string().max(40),
});
