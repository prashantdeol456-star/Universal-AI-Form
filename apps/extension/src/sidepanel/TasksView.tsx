import { useCallback, useEffect, useState } from "react";
import { controlTask, decideApproval, getTaskDetail, getTaskEvents, listTasks, type TaskDetail, type TaskEventView, type TaskSummary } from "./api";
import { controlsFor, isLive, STEP_LABEL, TASK_CLASS, TASK_LABEL, type TaskControlSet } from "./tasksMeta";

/**
 * Tasks tab: the user's persistent tasks (state lives on the server). Shows status, ordered
 * steps, recent events and approvals, with pause / resume / cancel / retry. It does not run
 * browser steps yet; tasks that need the browser show that they are waiting.
 */
export function TasksView({ server }: { server: string }) {
  const [list, setList] = useState<TaskSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await listTasks()).tasks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (openId) return <TaskDetailView id={openId} onBack={() => (setOpenId(null), void load())} server={server} />;

  return (
    <div className="pad stack">
      <div className="row-between">
        <div className="eyebrow">Your tasks</div>
        <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/tasks` })}>
          New task
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {list === null && !error && <p className="muted small">Loading…</p>}
      {list?.length === 0 && (
        <div className="card">
          <p className="small" style={{ margin: 0 }}>
            No tasks yet. Create one in the dashboard (email drafts, answers to application questions); it keeps going even when this panel is closed.
          </p>
        </div>
      )}
      {list?.map((t) => (
        <button key={t.id} className="card task-row" onClick={() => setOpenId(t.id)}>
          <div className="row-between">
            <span className="ellipsis">{t.title}</span>
            <span className={`badge ${TASK_CLASS[t.status]}`}>{TASK_LABEL[t.status]}</span>
          </div>
          <div className="small muted">
            {t.steps_done} of {t.steps_total} steps
          </div>
        </button>
      ))}
    </div>
  );
}

export function TaskDetailView({ id, onBack, server }: { id: string; onBack: () => void; server: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([getTaskDetail(id), getTaskEvents(id)]);
      setDetail(d);
      setEvents(e.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      void load();
    }
  }

  if (!detail) {
    return (
      <div className="pad stack">
        <button className="link small" onClick={onBack}>
          ← All tasks
        </button>
        {error ? <div className="alert">{error}</div> : <p className="muted small">Loading…</p>}
      </div>
    );
  }
  const c = controlsFor(detail);
  const pending = detail.approvals.find((a) => a.status === "pending");
  return (
    <div className="pad stack">
      <button className="link small" onClick={onBack}>
        ← All tasks
      </button>
      <div className="card">
        <div className="row-between">
          <b className="ellipsis">{detail.task.title}</b>
          <span className={`badge ${TASK_CLASS[detail.task.status]}`}>{TASK_LABEL[detail.task.status]}</span>
        </div>
        {detail.task.error_message && <div className="alert">{detail.task.error_message}</div>}
        {detail.task.status === "waiting_for_browser" && <div className="warn small">Browser steps run from this panel in a later update. You can cancel the task.</div>}
        <TaskControlsBar
          controls={c}
          busy={busy}
          confirmed={confirm}
          onConfirm={setConfirm}
          onAction={(action) => void act(() => controlTask(id, action === "retry" ? { action, confirmUncertain: confirm } : { action }))}
        />
        {error && <div className="alert">{error}</div>}
      </div>

      {pending && (
        <div className="card">
          <div className="eyebrow">Needs your approval</div>
          <p className="small" style={{ margin: 0 }}>
            {pending.action_summary}
          </p>
          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={() => void act(() => decideApproval(pending.id, "approve"))}>
              Approve
            </button>
            <button className="secondary" disabled={busy} onClick={() => void act(() => decideApproval(pending.id, "reject"))}>
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="eyebrow">Steps</div>
        <ol className="task-steps">
          {detail.steps.map((s) => (
            <li key={s.id}>
              <div className="row-between">
                <span className="ellipsis small">{s.title}</span>
                <span className={`badge ${s.status === "completed" ? "ok" : s.status === "failed" ? "man" : s.status === "waiting" || s.status === "running" ? "rev" : ""}`}>
                  {s.error_code === "needs_verification" ? "Check needed" : STEP_LABEL[s.status]}
                </span>
              </div>
              {s.error_message && <div className="small" style={{ color: "var(--err)" }}>{s.error_message}</div>}
            </li>
          ))}
        </ol>
        {detail.steps.some((s) => s.output) && (
          <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/tasks/${id}` })}>
            See drafts in the dashboard
          </button>
        )}
      </div>

      <div className="card">
        <div className="eyebrow">Recent activity</div>
        <ul className="task-events">
          {events.map((e) => (
            <li key={e.id} className="small">
              {e.message}
            </li>
          ))}
        </ul>
        {isLive(detail.task.status) && <p className="muted small" style={{ margin: 0 }}>Updates every few seconds.</p>}
      </div>
    </div>
  );
}

/** Pause / resume / retry / cancel buttons for the allowed transitions only. */
export function TaskControlsBar({
  controls: c,
  busy,
  confirmed,
  onConfirm,
  onAction,
}: {
  controls: TaskControlSet;
  busy: boolean;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  onAction: (a: "pause" | "resume" | "retry" | "cancel") => void;
}) {
  return (
    <>
      <div className="row-actions" aria-label="Task controls">
        {c.pause && (
          <button className="secondary" disabled={busy} onClick={() => onAction("pause")}>
            Pause
          </button>
        )}
        {c.resume && (
          <button className="primary" disabled={busy} onClick={() => onAction("resume")}>
            Resume
          </button>
        )}
        {c.retry && (
          <button className="primary" disabled={busy || (c.confirmUncertain && !confirmed)} onClick={() => onAction("retry")}>
            Retry
          </button>
        )}
        {c.cancel && (
          <button className="secondary" disabled={busy} onClick={() => onAction("cancel")}>
            Cancel task
          </button>
        )}
      </div>
      {c.confirmUncertain && (
        <label className="check small">
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />I checked: the interrupted step did not happen.
        </label>
      )}
    </>
  );
}
