import "server-only";
import { randomUUID } from "node:crypto";
import { redact } from "@ufa/security";
import { env } from "../env";
import { tasks } from "./engine";

/**
 * In-process task runner, like the document worker: a timer claims queued tasks with a
 * lease (safe with several web containers) and advances them one step at a time.
 */
const g = globalThis as unknown as { __ufaTaskRunner?: NodeJS.Timeout; __ufaTaskRunnerBusy?: boolean };

export function startTaskRunner(intervalMs = 3_000) {
  if (g.__ufaTaskRunner || !env().TASKS_RUNNER_ENABLED) return;
  const workerId = `web-${process.pid}-${randomUUID().slice(0, 8)}`;
  const tick = async () => {
    if (g.__ufaTaskRunnerBusy) return;
    g.__ufaTaskRunnerBusy = true;
    try {
      await tasks().runOnce(workerId);
    } catch (err) {
      console.error(`[tasks] runner tick failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    } finally {
      g.__ufaTaskRunnerBusy = false;
    }
  };
  g.__ufaTaskRunner = setInterval(() => void tick(), intervalMs);
  g.__ufaTaskRunner.unref?.();
  console.info("[tasks] runner started");
}

/** Called after a user action so the task moves at once instead of on the next tick. */
export function kickTaskRunner() {
  if (!g.__ufaTaskRunner) return;
  setTimeout(() => {
    if (g.__ufaTaskRunnerBusy) return;
    g.__ufaTaskRunnerBusy = true;
    tasks()
      .runOnce(`web-${process.pid}-kick`)
      .catch((err: unknown) => console.error(`[tasks] runner kick failed: ${redact(err instanceof Error ? err.message : String(err))}`))
      .finally(() => {
        g.__ufaTaskRunnerBusy = false;
      });
  }, 50).unref?.();
}
