import Link from "next/link";
import { IconArrowRight, IconCheckCircle, IconForm, IconHistory, IconPuzzle } from "@/components/icons";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { statusMeta, timeAgo } from "@/lib/labels";
import { searchApplications } from "@/server/applications/history";
import { requirePageUser } from "@/server/auth/session";
import { MarkSubmitted } from "./ApplicationClient";

export default async function ApplicationsPage() {
  const user = await requirePageUser();
  const [waiting, submitted, all] = await Promise.all([
    searchApplications(user, { status: "CONFIRMED", pageSize: 50 }),
    searchApplications(user, { status: "SUBMITTED", pageSize: 5 }),
    searchApplications(user, { pageSize: 1 }),
  ]);

  return (
    <>
      <PageHeader
        title="Applications"
        description="Forms you filled with the Chrome extension. The values you confirmed are kept as an unchangeable snapshot; the assistant never submits a form for you."
        actions={
          <ButtonLink href="/dashboard/history" variant="secondary">
            <IconHistory size={16} /> Full history
          </ButtonLink>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat icon={<IconForm size={20} />} label="All applications" value={all.total} />
        <Stat icon={<IconHistory size={20} />} tone="amber" label="Waiting for you to submit" value={waiting.total} />
        <Stat icon={<IconCheckCircle size={20} />} tone="green" label="Submitted" value={submitted.total} />
      </div>

      <Card title="Needs your attention" actions={waiting.total > 0 ? <Badge tone="amber">{waiting.total}</Badge> : undefined}>
        {waiting.items.length === 0 ? (
          <EmptyState icon={<IconCheckCircle size={22} />} title="Nothing waiting">
            Every filled form is marked as submitted or cancelled.
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-gray-100">
            {waiting.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <Link href={`/dashboard/applications/${a.id}`} className="min-w-0 hover:text-brand-700">
                  <span className="block truncate text-sm font-medium">{a.formName ?? a.domain}</span>
                  <span className="block text-xs text-gray-500">
                    {a.domain} · filled {timeAgo(a.createdAt)} · {a.filled ?? a.fields} fields
                  </span>
                </Link>
                <MarkSubmitted id={a.id} compact />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Recently submitted"
        actions={
          <Link href="/dashboard/history?status=SUBMITTED" className="text-xs font-semibold text-brand-600 hover:underline">
            See all
          </Link>
        }
      >
        {submitted.items.length === 0 ? (
          <EmptyState icon={<IconPuzzle size={22} />} title="No submitted applications yet">
            Open a form, click the extension icon and choose <b>Analyze form</b>. After you submit on the website, press <b>I submitted this form</b>.
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-gray-100">
            {submitted.items.map((a) => (
              <li key={a.id}>
                <Link href={`/dashboard/applications/${a.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-gray-50">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900">{a.formName ?? a.domain}</span>
                    <span className="block truncate text-xs text-gray-500">
                      {a.applicationNumber ? `No. ${a.applicationNumber} · ` : ""}
                      {a.domain} · {timeAgo(a.submittedAt ?? a.createdAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={statusMeta(a.status).tone}>{statusMeta(a.status).label}</Badge>
                    <IconArrowRight size={15} className="text-gray-300" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
