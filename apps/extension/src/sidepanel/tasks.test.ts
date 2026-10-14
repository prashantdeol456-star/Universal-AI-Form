import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskDetail, TaskStatus } from "./api";
import { controlsFor } from "./tasksMeta";
import { TaskControlsBar } from "./TasksView";

const detail = (status: TaskStatus, steps: Array<Partial<TaskDetail["steps"][number]>> = []): TaskDetail => ({
  task: { id: "t", title: "Task", task_type: "draft_email", status, error_message: null, created_at: "2026-10-15T00:00:00Z", steps_total: steps.length, steps_done: 0 },
  steps: steps.map((s, i) => ({ id: `s${i}`, step_key: `k${i}`, title: `Step ${i}`, status: "pending", error_code: null, error_message: null, attempt_count: 0, output: null, ...s })),
  approvals: [],
});

const render = (d: TaskDetail, confirmed = false) =>
  renderToStaticMarkup(createElement(TaskControlsBar, { controls: controlsFor(d), busy: false, confirmed, onConfirm: () => {}, onAction: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);

describe("extension task controls", () => {
  it("shows only the controls each status allows", () => {
    expect(buttons(render(detail("queued")))).toEqual(["Pause", "Cancel task"]);
    expect(buttons(render(detail("running")))).toEqual(["Pause", "Cancel task"]);
    expect(buttons(render(detail("waiting_for_approval")))).toEqual(["Pause", "Cancel task"]);
    expect(buttons(render(detail("paused")))).toEqual(["Resume", "Cancel task"]);
    expect(buttons(render(detail("failed", [{ status: "failed", attempt_count: 1 }])))).toEqual(["Retry", "Cancel task"]);
    expect(buttons(render(detail("completed")))).toEqual([]);
    expect(buttons(render(detail("cancelled")))).toEqual([]);
  });

  it("does not offer retry after the attempt limit", () => {
    expect(buttons(render(detail("failed", [{ status: "failed", attempt_count: 3 }])))).toEqual(["Cancel task"]);
  });

  it("asks for confirmation before retrying an interrupted step", () => {
    const uncertain = detail("paused", [{ status: "waiting", error_code: "needs_verification", attempt_count: 1 }]);
    const html = render(uncertain);
    expect(buttons(html)).toEqual(["Retry", "Cancel task"]);
    expect(html).toContain("the interrupted step did not happen");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/);
    expect(render(uncertain, true)).not.toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/);
    // No resume while the step is unverified.
    expect(controlsFor(uncertain).resume).toBe(false);
  });
});
