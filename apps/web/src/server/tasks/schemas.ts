import { TASK_STATUSES } from "@ufa/shared/tasks";
import { z } from "zod";

/**
 * Request schemas for the task API. Worker payloads are small JSON objects; keys that look
 * like credentials are refused so passwords, OTPs, tokens or cookies never land in task rows.
 */
const SECRET_KEY = /pass(word)?|otp|token|cookie|secret|session|authorization|cvv|pin$/i;

function hasSecretKey(v: unknown, depth = 0): boolean {
  if (depth > 6 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasSecretKey(x, depth + 1));
  return Object.entries(v).some(([k, x]) => SECRET_KEY.test(k) || hasSecretKey(x, depth + 1));
}

export const safeJsonObject = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 20_000, "Payload is too large (20 KB max)")
  .refine((v) => !hasSecretKey(v), "Payload must not contain passwords, OTPs, tokens or cookies");

export const createTaskSchema = z.object({
  taskType: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  title: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(2000).nullish(),
  input: safeJsonObject.default({}),
  priority: z.number().int().min(-10).max(10).optional(),
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).nullish(),
});

export const listTasksQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  beforeCreatedAt: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.uuid().optional(),
});

export const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().regex(/^\d{1,18}$/).optional(),
});

export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry"), stepId: z.uuid().nullish(), confirmUncertain: z.boolean().default(false) }),
]);

export const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(300).nullish(),
});

export const claimSchema = z.object({ workerId: z.string().regex(/^[A-Za-z0-9:_-]{4,100}$/) });

export const reportSchema = z.object({
  leaseToken: z.uuid(),
  outcome: z.enum(["progress", "completed", "failed", "uncertain"]),
  message: z.string().trim().max(300).nullish(),
  result: safeJsonObject.nullish(),
  checkpoint: safeJsonObject.nullish(),
});

export const checkpointSchema = z.object({ leaseToken: z.uuid(), data: safeJsonObject });
