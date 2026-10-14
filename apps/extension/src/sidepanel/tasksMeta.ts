import type { StepStatus, TaskDetail, TaskStatus } from "./api";

/** What the user may do with a task right now (mirrors the server's state machine; the server re-checks). */
export interface TaskControlSet {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  retry: boolean;
  /** Retry needs the user's confirmation that an interrupted step did not happen. */
  confirmUncertain: boolean;
}

export function controlsFor(detail: Pick<TaskDetail, "task" | "steps">): TaskControlSet {
  const s = detail.task.status;
  const uncertain = detail.steps.some((st) => st.status === "waiting" && st.error_code === "needs_verification");
  const failedStep = detail.steps.find((st) => st.status === "failed");
  const active = s === "queued" || s === "running" || s === "waiting_for_browser" || s === "waiting_for_approval";
  return {
    pause: active,
    resume: s === "paused" && !uncertain,
    cancel: active || s === "paused" || s === "failed",
    retry: (s === "failed" && Boolean(failedStep && failedStep.attempt_count < 3)) || (s === "paused" && uncertain),
    confirmUncertain: uncertain,
  };
}

export const TASK_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_for_browser: "Waiting for the browser",
  waiting_for_approval: "Needs your approval",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Badge class per status (existing side-panel colour tokens). */
export const TASK_CLASS: Record<TaskStatus, string> = {
  queued: "",
  running: "ask",
  waiting_for_browser: "rev",
  waiting_for_approval: "rev",
  paused: "",
  completed: "ok",
  failed: "man",
  cancelled: "",
};

export const isLive = (s: TaskStatus) => s === "queued" || s === "running" || s === "waiting_for_browser" || s === "waiting_for_approval";
