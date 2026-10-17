"use client";

import { api } from "@/lib/api-client";

export interface TaskStep {
  id: string;
  step_key: string;
  status: string;
  result_json: Record<string, unknown> | null;
  error_message: string | null;
}
export interface TaskApproval {
  id: string;
  status: string;
  action_summary: string;
}
export interface TaskView {
  task: { id: string; status: string; error_message: string | null };
  steps: TaskStep[];
  approvals: TaskApproval[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates a task (persisted by the task engine: pausable, cancellable, visible under Tasks). */
export async function startTask(taskType: string, input: Record<string, unknown>): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const idempotencyKey = `${taskType}-${crypto.randomUUID()}`;
  const r = await api<{ task: { id: string } }>("/api/tasks", { body: { taskType, input, idempotencyKey } });
  return r.ok ? { ok: true, id: r.data.task.id } : { ok: false, error: r.error.message };
}

/** Polls until the task completes, fails, pauses or waits for an approval (max ~2 minutes). */
export async function waitTask(id: string, until: (v: TaskView) => boolean = () => false): Promise<TaskView | null> {
  for (let i = 0; i < 120; i++) {
    const r = await api<TaskView>(`/api/tasks/${id}`);
    if (r.ok) {
      const s = r.data.task.status;
      if (until(r.data) || ["completed", "failed", "cancelled", "paused", "waiting_for_approval", "needs_verification"].includes(s)) return r.data;
    }
    await sleep(i < 10 ? 500 : 1500);
  }
  return null;
}

export const stepResult = (v: TaskView | null, key: string) => v?.steps.find((s) => s.step_key === key)?.result_json ?? null;
