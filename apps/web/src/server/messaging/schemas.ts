import { z } from "zod";

/** Request validation for the messaging API (strict, bounded). */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const gmailThreadId = z.string().regex(/^[0-9a-f]{6,32}$/i, "Not a Gmail thread id");

export const connectSchema = z.object({ access: z.enum(["read", "read_draft"]) }).strict();
export const cloudSchema = z.object({ cloudAiAllowed: z.boolean() }).strict();

export const mailSearchSchema = z.object({
  text: z.string().trim().max(100).optional(),
  from: z.string().trim().max(100).optional(),
  subject: z.string().trim().max(100).optional(),
  after: date.optional(),
  before: date.optional(),
  unread: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  pageToken: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export const insightQuerySchema = z.object({ source: z.enum(["gmail", "whatsapp"]), ref: z.string().min(1).max(64).regex(/^[0-9a-zA-Z-]+$/) });
export const draftQuerySchema = z.object({ source: z.enum(["gmail", "whatsapp"]).optional(), ref: z.string().min(1).max(64).regex(/^[0-9a-zA-Z-]+$/).optional() });

export const draftPatchSchema = z
  .object({
    body: z.string().max(20_000).optional(),
    subject: z.string().trim().max(300).optional(),
    status: z.enum(["copied", "discarded"]).optional(),
  })
  .strict()
  .refine((v) => v.body !== undefined || v.subject !== undefined || v.status !== undefined, "Nothing to change");

export const chatPatchSchema = z
  .object({ cloudAiAllowed: z.boolean().optional(), retentionDays: z.number().int().min(1).max(365).optional() })
  .strict()
  .refine((v) => v.cloudAiAllowed !== undefined || v.retentionDays !== undefined, "Nothing to change");

export const importFields = z.object({
  myName: z.string().trim().min(1).max(80),
  title: z.string().trim().max(120).nullish(),
  dateOrder: z.enum(["dmy", "mdy", "auto"]).default("auto"),
  retentionDays: z.coerce.number().int().min(1).max(365).nullish(),
});
