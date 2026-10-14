import { describe, expect, it } from "vitest";
import { TaskTransitionError } from "@ufa/shared/tasks";
import { TaskError, taskErrorInfo } from "./types";

describe("taskErrorInfo", () => {
  it("maps engine errors to HTTP status and code, also for copies loaded by another bundle", () => {
    expect(taskErrorInfo(new TaskError("not_found", "Task not found"))).toEqual({ status: 404, code: "not_found", message: "Task not found" });
    expect(taskErrorInfo(new TaskError("lease_lost", "x"))?.status).toBe(409);
    expect(taskErrorInfo(new TaskTransitionError("task", "completed", "running"))).toMatchObject({ status: 409, code: "invalid_transition" });
    // A structurally identical error from a second copy of the class.
    const copy = Object.assign(new Error("Task not found"), { name: "TaskError", code: "not_found", status: 404 });
    expect(taskErrorInfo(copy)?.status).toBe(404);
    expect(taskErrorInfo(new Error("boom"))).toBeNull();
    expect(taskErrorInfo("text")).toBeNull();
  });
});
