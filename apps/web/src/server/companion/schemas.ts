import { FOLDER_ACCESS, IMPLEMENTED_CAPABILITIES, LOCAL_TASK_TYPES, type Capability, type LocalTaskType } from "@ufa/local-agent";
import { z } from "zod";
import { safeJsonObject } from "../tasks/schemas";
import { PREFERENCE_KEYS, type PreferenceKey } from "./memory";

/** Request schemas for the companion and agent APIs (strict: unknown keys are refused). */
const version = z.string().regex(/^[0-9A-Za-z.+-]{1,30}$/);
export const pollSecretHeader = z.string().regex(/^Bearer ([A-Za-z0-9_-]{43,86})$/);

export const pairStartSchema = z.strictObject({
  name: z.string().trim().min(1).max(60).regex(/^[^\0\r\n<>]+$/),
  platform: z.enum(["windows", "macos", "linux"]),
  version,
});
export const pairPollSchema = z.strictObject({ pairingId: z.uuid() });
export const pairConfirmSchema = z.strictObject({ code: z.string().trim().regex(/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/, "Enter the 8-character code shown on your computer"), confirm: z.boolean().default(false) });

export const devicePatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(60).regex(/^[^\0\r\n<>]+$/).optional(),
  capabilities: z.array(z.enum(IMPLEMENTED_CAPABILITIES as [Capability, ...Capability[]])).max(10).optional(),
  aiExcerptsAllowed: z.boolean().optional(),
  cloudAiAllowed: z.boolean().optional(),
});
export const stopSchema = z.strictObject({ action: z.enum(["stop", "clear"]) });

export const heartbeatSchema = z.strictObject({
  version,
  localAi: z.enum(["available", "unavailable", "unknown"]).default("unknown"),
  folders: z
    .array(z.strictObject({ id: z.uuid(), label: z.string().trim().min(1).max(60), displayPath: z.string().min(1).max(300), access: z.array(z.enum(FOLDER_ACCESS)).min(1).max(3) }))
    .max(50),
});

export const deviceReportSchema = z.strictObject({
  leaseToken: z.uuid(),
  outcome: z.enum(["progress", "completed", "failed", "uncertain"]),
  message: z.string().trim().max(300).nullish(),
  result: safeJsonObject.nullish(),
  // Personal output (summaries, file lists, command output): stored encrypted.
  secret: z.string().max(200_000).nullish(),
});

export const planSchema = z.strictObject({ deviceId: z.uuid(), request: z.string().trim().min(3).max(500) });
export const localTaskSchema = z.strictObject({
  deviceId: z.uuid(),
  taskType: z.enum(LOCAL_TASK_TYPES as [LocalTaskType, ...LocalTaskType[]]),
  input: safeJsonObject,
  title: z.string().trim().max(200).nullish(),
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).nullish(),
});

export const workflowCreateSchema = z.strictObject({ taskId: z.uuid(), name: z.string().trim().min(1).max(100) });
export const workflowPatchSchema = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(["draft", "approved", "disabled"]).optional() });
export const workflowRunSchema = z.strictObject({ deviceId: z.uuid() });

const prefKeys = Object.keys(PREFERENCE_KEYS) as [PreferenceKey, ...PreferenceKey[]];
export const preferenceSchema = z.strictObject({ key: z.enum(prefKeys), value: z.string().trim().min(1).max(100), source: z.enum(["user", "feedback"]).default("user") });
export const preferenceDeleteQuery = z.object({ key: z.enum(prefKeys) });

export const feedbackSchema = z.strictObject({
  correct: z.boolean(),
  wrongStepKey: z.string().regex(/^[a-z0-9_.-]{1,60}$/).nullish(),
  note: z.string().trim().max(500).nullish().transform((v) => v || null),
  scope: z.enum(["one_time", "future"]).default("one_time"),
});
