import Link from "next/link";
import { APPLICATION_STATUS_LABELS, APPLICATION_STATUSES, dueState } from "@ufa/jobs";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { listApplications } from "@/server/jobs/service";
import { JobsNav } from "../JobsNav";

export default async function TrackerPage() {
  const user = await requirePageUser();
  const apps = await listApplications(user);
  const today = new Date().toISOString().slice(0, 10);
  const urgent = apps.filter((a) => ["overdue", "today", "soon"].includes(dueState(a.deadline, today) ?? "") || ["overdue", "today", "soon"].includes(dueState(a.nextFollowUp, today) ?? ""));
  const due = (d: string | null, label: string) => {
    const s = dueState(d, today);
    if (!s) return null;
    const tone = s === "overdue" ? "red" : s === "later" ? "gray" : "amber";
    return (
      <Badge tone={tone}>
        {label} {d}
        {s === "overdue" ? " (overdue)" : s === "today" ? " (today)" : ""}
      </Badge>
    );
  };
  return (
    <>
      <PageHeader title="Applications" description="Track where each application stands. You change the status yourself; filling a form never marks a job as applied. Reminders appear here only; nothing is emailed or messaged." />
      <JobsNav active="/dashboard/jobs/tracker" />
      {urgent.length > 0 && (
        <Card title="Needs attention">
          <ul className="space-y-1 text-sm">
            {urgent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                {a.jobId ? <Link href={`/dashboard/jobs/${a.jobId}`} className="font-medium text-brand-700 hover:underline">{a.title}</Link> : <span className="font-medium">{a.title}</span>}
                {due(a.deadline, "Deadline")}
                {due(a.nextFollowUp, "Follow-up")}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {apps.length === 0 ? (
        <EmptyState title="No applications tracked yet">Open a job and set its status (for example “Interested” or “Preparing”).</EmptyState>
      ) : (
        APPLICATION_STATUSES.filter((s) => apps.some((a) => a.status === s)).map((s) => (
          <Card key={s} title={`${APPLICATION_STATUS_LABELS[s]} (${apps.filter((a) => a.status === s).length})`}>
            <ul className="divide-y divide-gray-100">
              {apps
                .filter((a) => a.status === s)
                .map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div>
                      {a.jobId ? (
                        <Link href={`/dashboard/jobs/${a.jobId}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                          {a.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{a.title} <span className="text-xs text-gray-500">(listing removed)</span></span>
                      )}
                      <div className="text-xs text-gray-500">
                        {a.employer ?? "Employer not given"} · last activity {new Date(a.lastActivityAt).toLocaleDateString("en-IN")}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {due(a.deadline, "Deadline")}
                      {due(a.nextFollowUp, "Follow-up")}
                    </div>
                  </li>
                ))}
            </ul>
          </Card>
        ))
      )}
    </>
  );
}
