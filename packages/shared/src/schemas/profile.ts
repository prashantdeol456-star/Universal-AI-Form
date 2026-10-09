import { z } from "zod";

export const fieldKeySchema = z
  .string()
  .max(120)
  .regex(/^[a-z_]+(\.[a-z0-9_]+)+$/, "Invalid field key");

export const updateProfileFieldSchema = z.object({
  fieldKey: fieldKeySchema,
  value: z.string().max(2000),
  /** Set when the user explicitly confirms replacing an already verified value. */
  confirmOverwrite: z.boolean().optional().default(false),
});
export type UpdateProfileFieldInput = z.infer<typeof updateProfileFieldSchema>;

export const createCustomFieldSchema = z.object({
  label: z.string().trim().min(1).max(120),
  dataType: z.enum(["text", "number", "date", "boolean", "select"]).default("text"),
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  isSensitive: z.boolean().default(false),
  value: z.string().max(2000).optional(),
});
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

export const resolveConflictSchema = z.object({
  conflictId: z.uuid(),
  chosenIndex: z.number().int().min(0).optional(),
  customValue: z.string().max(2000).optional(),
});
