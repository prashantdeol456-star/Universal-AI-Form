/**
 * Task engine state machines (AI browser Phase 1). Pure data and checks, shared by the
 * server, the database tests and the extension. The database stores the same status
 * values (migration 0016); every status change in code goes through assertTaskTransition
 * or assertStepTransition, and the SQL updates repeat the allowed "from" states so two
 * concurrent writers cannot both win.
 */

export const TASK_STATUSES = ["queued", "running", "waiting_for_browser", "waiting_for_approval", "paused", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ["pending", "running", "waiting", "completed", "failed", "skipped", "cancelled"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "waiting_for_browser", "waiting_for_approval", "paused", "completed", "failed", "cancelled"],
  running: ["queued", "waiting_for_browser", "waiting_for_approval", "paused", "completed", "failed", "cancelled"],
  waiting_for_browser: ["running", "paused", "failed", "cancelled"],
  waiting_for_approval: ["queued", "paused", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  failed: ["queued", "cancelled"],
  completed: [],
  cancelled: [],
};

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["running", "waiting", "skipped", "cancelled"],
  running: ["completed", "failed", "waiting", "pending", "cancelled"],
  waiting: ["running", "completed", "failed", "pending", "cancelled"],
  failed: ["pending", "cancelled"],
  completed: [],
  skipped: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "cancelled"];
export const DONE_STEP_STATUSES: readonly StepStatus[] = ["completed", "skipped", "cancelled"];

/** Statuses from which the user may pause / resume / cancel / retry. */
export const PAUSABLE: readonly TaskStatus[] = ["queued", "running", "waiting_for_browser", "waiting_for_approval"];
export const CANCELLABLE: readonly TaskStatus[] = ["queued", "running", "waiting_for_browser", "waiting_for_approval", "paused", "failed"];

export class TaskTransitionError extends Error {
  readonly code = "invalid_transition";
  constructor(
    readonly kind: "task" | "step",
    readonly from: string,
    readonly to: string,
  ) {
    super(`A ${kind} cannot go from "${from}" to "${to}"`);
    this.name = "TaskTransitionError";
  }
}

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canStepTransition(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTaskTransition(from, to)) throw new TaskTransitionError("task", from, to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canStepTransition(from, to)) throw new TaskTransitionError("step", from, to);
}

/** The task statuses from which `to` may be entered (used in SQL "where status = any(...)"). */
export function taskSourcesFor(to: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((s) => TASK_TRANSITIONS[s].includes(to));
}

export function stepSourcesFor(to: StepStatus): StepStatus[] {
  return STEP_STATUSES.filter((s) => STEP_TRANSITIONS[s].includes(to));
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_for_browser: "Waiting for your browser or computer",
  waiting_for_approval: "Needs your approval",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Task types the user can create, with what they do. Browser types wait until browser steps exist. */
export const TASK_TYPES = {
  draft_email: { label: "Draft an email", browser: false },
  draft_answers: { label: "Draft answers to application questions", browser: false },
  fill_form: { label: "Fill a form in the browser", browser: true },
  summarize_email_thread: { label: "Summarise an email conversation", browser: false },
  draft_email_reply: { label: "Draft an email reply (Gmail draft after approval)", browser: false },
  summarize_whatsapp_conversation: { label: "Summarise an imported WhatsApp chat", browser: false },
  draft_whatsapp_reply: { label: "Draft a WhatsApp reply (you copy it)", browser: false },
  // Phase 6: run on a paired computer by the local companion.
  local_summarize_files: { label: "Summarise files on your computer", browser: false, local: true },
  local_organize_files: { label: "Organise a folder on your computer (after you approve the preview)", browser: false, local: true },
  local_create_report: { label: "Create a file report on your computer", browser: false, local: true },
  local_run_command: { label: "Run an approved command on your computer", browser: false, local: true },
  local_undo_changes: { label: "Undo an organise on your computer", browser: false, local: true },
} as const;
export type TaskType = keyof typeof TASK_TYPES;
