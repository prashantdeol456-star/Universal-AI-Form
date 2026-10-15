import type { ApprovalStatus, StepStatus, TaskStatus } from "@ufa/shared/tasks";
import type { TransactionSql } from "@ufa/db";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type StepType = `server.${string}` | `browser.${string}` | `approval.${string}`;

export interface StepSpec {
  key: string;
  type: StepType;
  title: string;
  /** Running it twice is harmless (no external effect). Defaults to true for server steps, false for browser steps. */
  idempotent?: boolean;
  input?: JsonObject;
  /** Explicit order (default: position in the list). Lets later pages slot in before a final step. */
  sequence?: number;
}

/** How a task type turns the user's input into ordered steps. */
export interface TaskTemplate<I extends JsonObject = JsonObject> {
  /** Validates and normalises the input; throws TaskError("invalid_input") when it is wrong. */
  parse(input: unknown): I;
  defaultTitle(input: I): string;
  steps(input: I): StepSpec[];
  /**
   * Multi-page tasks: the steps for page `pageNumber` at `url`, added after the user moved to
   * the next page themselves. Throws TaskError("invalid_input") for a page on another site.
   */
  nextPage?(input: I, pageNumber: number, url: string): StepSpec[];
}

export interface StepContext {
  userId: string;
  role: string;
  taskId: string;
  stepId: string;
  stepKey: string;
  taskInput: JsonObject;
  stepInput: JsonObject;
  /** Results of earlier completed steps, by step key. */
  previous: Record<string, { result: Json | null; secret: string | null }>;
}

export interface ServerStepOutput {
  /** Non-sensitive structured result (shown in the UI, kept as is). */
  result?: JsonObject;
  /** Personal text (a draft, an answer): stored encrypted. */
  secret?: string;
  message?: string;
}
export type ServerStepHandler = (ctx: StepContext) => Promise<ServerStepOutput>;

export interface ApprovalSpec {
  actionType: string;
  summary(ctx: StepContext): string;
  /** The minimum that identifies what is approved; hashed to bind the approval to it. */
  payload(ctx: StepContext): JsonObject;
  /** Carried out once, in the user's transaction, after approval. Must not contact external services in Phase 1. */
  effect?(ctx: StepContext, tx: TransactionSql): Promise<JsonObject | void>;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: TaskStatus;
  priority: number;
  input_json: JsonObject;
  result_json: JsonObject | null;
  checkpoint_json: JsonObject | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  last_checkpoint_at: Date | null;
}

export interface StepRow {
  id: string;
  task_id: string;
  user_id: string;
  step_key: string;
  step_type: StepType;
  title: string;
  status: StepStatus;
  idempotent: boolean;
  input_json: JsonObject;
  result_json: JsonObject | null;
  result_secret: string | null;
  error_code: string | null;
  error_message: string | null;
  sequence_number: number;
  attempt_count: number;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  user_id: string;
  step_id: string;
  action_type: string;
  action_summary: string;
  status: ApprovalStatus;
  requested_payload_json: JsonObject;
  payload_hash: string;
  decision_payload_json: JsonObject | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface EventRow {
  id: string;
  task_id: string;
  step_id: string | null;
  event_type: string;
  message: string;
  metadata_json: JsonObject;
  created_at: Date;
}

export interface Actor {
  id: string;
  role: string;
}

export type TaskErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_transition"
  | "lease_lost"
  | "approval_expired"
  | "approval_decided"
  | "needs_verification"
  | "retry_not_allowed";

const STATUS: Record<TaskErrorCode, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 409,
  lease_lost: 409,
  approval_expired: 409,
  approval_decided: 409,
  needs_verification: 409,
  retry_not_allowed: 409,
};

export class TaskError extends Error {
  readonly status: number;
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
    this.status = STATUS[code];
  }
}

/**
 * Recognises task engine errors by name and code rather than instanceof: bundlers (Next.js dev)
 * can load this package twice, and then instanceof fails across the two copies.
 */
export function taskErrorInfo(err: unknown): { status: number; code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { code?: unknown; status?: unknown };
  if (e.name === "TaskError" && typeof e.code === "string" && typeof e.status === "number") return { status: e.status, code: e.code, message: e.message };
  if (e.name === "TaskTransitionError" && e.code === "invalid_transition") return { status: 409, code: "invalid_transition", message: e.message };
  return null;
}
