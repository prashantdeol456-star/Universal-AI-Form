import Link from "next/link";
import { notFound } from "next/navigation";
import { taskErrorInfo } from "@ufa/tasks";
import { STEP_STATUS_LABELS, TASK_STATUS_LABELS, TASK_TYPES } from "@ufa/shared/tasks";
import { Badge, Card, PageHeader } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { tasks } from "@/server/tasks/engine";
import { STEP_TONE, TASK_TONE } from "../meta";
import { ApprovalActions, AutoRefresh, CopyButton, TaskControls } from "../TasksClient";

/** Step output for the owner: an email draft is JSON {subject, body}; answers are plain text. */
function outputText(output: string): { subject?: string; body: string } {
  try {
    const o = JSON.parse(output) as { subject?: string; body?: string };
    if (typeof o.body === "string") return { subject: o.subject, body: o.body };
  } catch {
    // plain text
  }
  return { body: output };
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let view;
  let events;
  try {
    view = await tasks().getTask(user, id);
    events = (await tasks().listEvents(user, id, { limit: 50 })).events;
  } catch (err) {
    if (taskErrorInfo(err)?.code === "not_found") notFound();
    throw err;
  }
  const { task, steps, approvals } = view;
  const pending = approvals.find((a) => a.status === "pending");
  const uncertain = steps.some((s) => s.status === "waiting" && s.error_code === "needs_verification");
  const failedStep = steps.find((s) => s.status === "failed");
  const canRetry = Boolean((failedStep && failedStep.attempt_count < 3) || uncertain);
  const live = !["completed", "cancelled", "failed", "paused"].includes(task.status);
  const browserType = TASK_TYPES[task.task_type as keyof typeof TASK_TYPES]?.browser;

  return (
    <>
      <AutoRefresh active={live} />
      <PageHeader
        eyebrow={
          <Link href="/dashboard/tasks" className="hover:underline">
            Tasks
          </Link>
        }
        title={task.title}
        description={TASK_TYPES[task.task_type as keyof typeof TASK_TYPES]?.label ?? task.task_type}
        actions={<Badge tone={TASK_TONE[task.status]}>{TASK_STATUS_LABELS[task.status]}</Badge>}
      />

      {task.error_message && (
        <Card>
          <p className="text-sm text-red-700">{task.error_message}</p>
        </Card>
      )}
      {task.status === "waiting_for_browser" && browserType && (
        <Card>
          <p className="text-sm text-gray-700">This task waits for browser steps. Running them from the extension arrives in a later phase; until then you can cancel it.</p>
        </Card>
      )}

      {pending && (
        <Card title="Needs your approval">
          <p className="mb-3 text-sm text-gray-700">{pending.action_summary}</p>
          <p className="mb-3 text-xs text-gray-500">Expires {new Date(pending.expires_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · approving allows only this one action.</p>
          <ApprovalActions id={pending.id} />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Steps">
          <ol className="space-y-3">
            {steps.map((s, i) => {
              const out = s.output ? outputText(s.output) : null;
              return (
                <li key={s.id} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <span className="mr-2 text-xs text-gray-400 tabular-nums">{i + 1}</span>
                      <span className="font-medium text-gray-900">{s.title}</span>
                      {s.attempt_count > 1 && <span className="ml-2 text-xs text-gray-500">attempt {s.attempt_count}</span>}
                    </div>
                    <Badge tone={STEP_TONE[s.status]}>{s.error_code === "needs_verification" ? "Check needed" : STEP_STATUS_LABELS[s.status]}</Badge>
                  </div>
                  {s.error_message && <p className="mt-1 text-xs text-red-700">{s.error_message}</p>}
                  {out && (
                    <div className="mt-2 rounded-md bg-gray-50 p-2 text-sm">
                      {out.subject && <div className="mb-1 font-semibold text-gray-900">{out.subject}</div>}
                      <p className="whitespace-pre-wrap text-gray-700">{out.body}</p>
                      <div className="mt-1">
                        <CopyButton text={out.subject ? `${out.subject}\n\n${out.body}` : out.body} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card title="Controls">
            <TaskControls id={task.id} status={task.status} uncertain={uncertain} canRetry={canRetry} />
            {!live && task.status !== "paused" && task.status !== "failed" && <p className="text-sm text-gray-500">This task is {TASK_STATUS_LABELS[task.status].toLowerCase()}.</p>}
          </Card>
          <Card title="History">
            <ul className="space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex justify-between gap-3">
                  <span className="text-gray-700">{e.message}</span>
                  <span className="shrink-0 text-xs text-gray-400">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
