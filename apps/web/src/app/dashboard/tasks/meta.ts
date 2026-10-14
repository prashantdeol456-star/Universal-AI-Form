import type { StepStatus, TaskStatus } from "@ufa/shared/tasks";

type Tone = "gray" | "green" | "amber" | "red" | "blue";

export const TASK_TONE: Record<TaskStatus, Tone> = {
  queued: "gray",
  running: "blue",
  waiting_for_browser: "amber",
  waiting_for_approval: "amber",
  paused: "gray",
  completed: "green",
  failed: "red",
  cancelled: "gray",
};

export const STEP_TONE: Record<StepStatus, Tone> = {
  pending: "gray",
  running: "blue",
  waiting: "amber",
  completed: "green",
  failed: "red",
  skipped: "gray",
  cancelled: "gray",
};
