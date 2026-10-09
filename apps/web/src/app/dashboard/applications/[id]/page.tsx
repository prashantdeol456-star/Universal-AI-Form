import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { IconExternal, IconFile, IconForm, IconHistory } from "@/components/icons";
import { Badge, Card, Stat } from "@/components/ui";
import { formatDateTime, statusMeta } from "@/lib/labels";
import { getApplication } from "@/server/applications/history";
import { requirePageUser } from "@/server/auth/session";
import { HttpError } from "@/server/http";
import { findSavedForm } from "@/server/saved-forms/service";
import { CancelApplication, DocumentLinks, EditApplicationNumber, MarkSubmitted, SaveFormButton, SnapshotTable } from "../ApplicationClient";

type Props = { params: Promise<{ id: string }> };

const EVENT_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  CONFIRMED: (d) => `You confirmed ${d.fields ?? "the"} values${Number(d.manual) ? ` (${d.manual} typed by you)` : ""}`,
  FILLED: (d) => `Filled on the website: ${d.filled ?? 0} filled${Number(d.skipped) ? `, ${d.skipped} skipped` : ""}${Number(d.failed) ? `, ${d.failed} not filled` : ""}`,
  UNDONE: (d) => `Fill undone (${d.restored ?? 0} fields restored)`,
  SUBMITTED: () => "Marked as submitted by you",
  CANCELLED: () => "Marked as not submitted",
  UPDATED: () => "Application number updated",
  DOCUMENTS_LINKED: (d) => `${d.count ?? 1} document${Number(d.count) === 1 ? "" : "s"} linked`,
  DOCUMENT_UNLINKED: () => "A document was unlinked",
};

export default async function ApplicationDetailPage({ params }: Props) {
  const user = await requirePageUser();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  let app;
  try {
    app = await getApplication(user, id.data);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const saved = await findSavedForm(user, app.websiteUrl).catch(() => null);
  const meta = statusMeta(app.status);

  return (
    <>
      <div>
        <Link href="/dashboard/history" className="text-xs font-medium text-gray-500 hover:text-gray-800">
          ← Application history
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{app.formName ?? app.domain}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <a href={app.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-brand-700">
                {app.domain} <IconExternal size={13} />
              </a>
              <span>· confirmed {formatDateTime(app.confirmedAt)}</span>
            </div>
          </div>
          <SaveFormButton name={app.formName ?? app.domain} url={app.websiteUrl} saved={Boolean(saved)} />
        </div>
      </div>

      {app.status === "CONFIRMED" && (
        <Card className="border-amber-200 bg-amber-50/60">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl text-sm text-amber-900">
              <b>Did you submit this form on the website?</b> The assistant never submits. Once you have, mark it here so your history stays accurate.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MarkSubmitted id={app.id} compact />
              <CancelApplication id={app.id} />
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat icon={<IconForm size={20} />} label="Fields confirmed" value={app.fields} hint={app.filled !== null ? `${app.filled} filled on the page` : "Fill result not reported"} />
        <Stat icon={<IconFile size={20} />} tone="amber" label="Documents linked" value={app.documents} />
        <Stat
          icon={<IconHistory size={20} />}
          tone="green"
          label="Application number"
          value={<span className="text-lg">{app.applicationNumber ?? "—"}</span>}
          hint={<EditApplicationNumber id={app.id} initial={app.applicationNumber} />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Values filled (snapshot)" actions={<span className="text-xs text-gray-400">cannot be changed</span>}>
          <SnapshotTable applicationId={app.id} fields={app.fieldsList} />
        </Card>
        <div className="space-y-6">
          <Card title="Timeline">
            <ol className="relative space-y-4 border-l border-gray-200 pl-4">
              {app.events.map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-brand-500 ring-4 ring-white" aria-hidden="true" />
                  <div className="text-sm text-gray-800">{EVENT_TEXT[e.type]?.(e.details) ?? e.type}</div>
                  <time className="text-xs text-gray-400" dateTime={e.at}>
                    {formatDateTime(e.at)}
                  </time>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="Documents used">
            <DocumentLinks applicationId={app.id} linked={app.linkedDocuments} available={app.availableDocuments} />
          </Card>
        </div>
      </div>
    </>
  );
}
