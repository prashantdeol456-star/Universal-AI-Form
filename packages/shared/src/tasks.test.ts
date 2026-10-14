import { describe, expect, it } from "vitest";
import {
  assertStepTransition,
  assertTaskTransition,
  canStepTransition,
  canTaskTransition,
  STEP_STATUSES,
  stepSourcesFor,
  TASK_STATUSES,
  taskSourcesFor,
  TaskTransitionError,
  type StepStatus,
  type TaskStatus,
} from "./tasks";

// The allowed transitions, written out independently of the implementation's table.
const TASK_OK = new Set([
  "queued>running", "queued>waiting_for_browser", "queued>waiting_for_approval", "queued>paused", "queued>completed", "queued>failed", "queued>cancelled",
  "running>queued", "running>waiting_for_browser", "running>waiting_for_approval", "running>paused", "running>completed", "running>failed", "running>cancelled",
  "waiting_for_browser>running", "waiting_for_browser>paused", "waiting_for_browser>failed", "waiting_for_browser>cancelled",
  "waiting_for_approval>queued", "waiting_for_approval>paused", "waiting_for_approval>failed", "waiting_for_approval>cancelled",
  "paused>queued", "paused>cancelled",
  "failed>queued", "failed>cancelled",
]);
const STEP_OK = new Set([
  "pending>running", "pending>waiting", "pending>skipped", "pending>cancelled",
  "running>completed", "running>failed", "running>waiting", "running>pending", "running>cancelled",
  "waiting>running", "waiting>completed", "waiting>failed", "waiting>pending", "waiting>cancelled",
  "failed>pending", "failed>cancelled",
]);

describe("task state machine", () => {
  it("allows exactly the documented task transitions (every pair checked)", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const ok = TASK_OK.has(`${from}>${to}`);
        expect(canTaskTransition(from, to), `${from} → ${to}`).toBe(ok);
        if (ok) expect(() => assertTaskTransition(from, to)).not.toThrow();
        else expect(() => assertTaskTransition(from, to)).toThrow(TaskTransitionError);
      }
    }
  });

  it("allows exactly the documented step transitions (every pair checked)", () => {
    for (const from of STEP_STATUSES) {
      for (const to of STEP_STATUSES) {
        const ok = STEP_OK.has(`${from}>${to}`);
        expect(canStepTransition(from, to), `${from} → ${to}`).toBe(ok);
        if (!ok) expect(() => assertStepTransition(from, to)).toThrow(TaskTransitionError);
      }
    }
  });

  it("keeps completed and cancelled tasks final and gives a typed error", () => {
    for (const to of TASK_STATUSES) {
      expect(canTaskTransition("completed", to)).toBe(false);
      expect(canTaskTransition("cancelled", to)).toBe(false);
    }
    try {
      assertTaskTransition("completed" as TaskStatus, "running");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TaskTransitionError);
      expect(err).toMatchObject({ code: "invalid_transition", kind: "task", from: "completed", to: "running" });
    }
    expect(() => assertStepTransition("completed" as StepStatus, "pending")).toThrow(/cannot go from "completed" to "pending"/);
  });

  it("lists the source states for SQL guards", () => {
    expect(taskSourcesFor("paused").sort()).toEqual(["queued", "running", "waiting_for_approval", "waiting_for_browser"]);
    expect(taskSourcesFor("queued").sort()).toEqual(["failed", "paused", "running", "waiting_for_approval"]);
    expect(stepSourcesFor("completed").sort()).toEqual(["running", "waiting"]);
  });
});
