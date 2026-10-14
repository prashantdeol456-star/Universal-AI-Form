import Link from "next/link";
import { TASK_STATUS_LABELS, TASK_STATUSES, TASK_TYPES, type TaskStatus } from "@ufa/shared/tasks";
import { IconSpark } from "@/components/icons";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, ProgressBar } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { tasks } from "@/server/tasks/engine";
import { TASK_TONE } from "./meta";
import { NewTaskForm } from "./TasksClient";

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const status = TASK_STATUSES.includes(sp.status as TaskStatus) ? (sp.status as TaskStatus) : null;
  const before = sp.beforeCreatedAt && sp.beforeId && /^[0-9a-f-]{36}$/.test(sp.beforeId) && !Number.isNaN(Date.parse(sp.beforeCreatedAt)) ? { createdAt: sp.beforeCreatedAt, id: sp.beforeId } : null;
  const page = await tasks().listTasks(user, { status, limit: 20, before });
  const filterHref = (s: TaskStatus | null) => (s ? `/dashboard/tasks?status=${s}` : "/dashboard/tasks");

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Longer jobs the assistant works on step by step. They keep going when you close the page, wait for your approval before anything important, and can be paused or cancelled."
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <div className="flex flex-wrap gap-1.5" role="navigation" aria-label="Filter by status">
            {[null, ...TASK_STATUSES].map((s) => (
              <Link
                key={s ?? "all"}
                href={filterHref(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${s === status ? "bg-brand-50 text-brand-700 ring-brand-200" : "text-gray-600 ring-gray-200 hover:bg-gray-50"}`}
              >
                {s ? TASK_STATUS_LABELS[s] : "All"}
              </Link>
            ))}
          </div>
          <Card>
            {page.tasks.length === 0 ? (
              <EmptyState icon={<IconSpark size={22} />} title={status ? `No ${TASK_STATUS_LABELS[status].toLowerCase()} tasks` : "No tasks yet"}>
                Create one on the right, for example an email draft or answers to application questions.
              </EmptyState>
            ) : (
              <ul className="-my-2 divide-y divide-gray-100">
                {page.tasks.map((t) => (
                  <li key={t.id} className="py-3">
                    <Link href={`/dashboard/tasks/${t.id}`} className="block rounded-lg p-1 hover:bg-gray-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-gray-900">{t.title}</div>
                          <div className="text-xs text-gray-500">
                            {TASK_TYPES[t.task_type as keyof typeof TASK_TYPES]?.label ?? t.task_type} · {timeAgo(t.created_at)}
                          </div>
                        </div>
                        <Badge tone={TASK_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                      </div>
                      <div className="mt-2">
                        <ProgressBar value={t.steps_total ? (t.steps_done / t.steps_total) * 100 : 0} tone={t.status === "completed" ? "green" : "blue"} label={`${t.steps_done} of ${t.steps_total} steps`} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="flex justify-between">
            {before ? (
              <ButtonLink href={filterHref(status)} variant="secondary" size="sm">
                Newest
              </ButtonLink>
            ) : (
              <span />
            )}
            {page.next && (
              <ButtonLink
                href={`/dashboard/tasks?${new URLSearchParams({ ...(status ? { status } : {}), beforeCreatedAt: page.next.createdAt, beforeId: page.next.id })}`}
                variant="secondary"
                size="sm"
              >
                Older
              </ButtonLink>
            )}
          </div>
        </div>
        <Card className="lg:col-span-2" title="New task">
          <NewTaskForm />
        </Card>
      </div>
    </>
  );
}
