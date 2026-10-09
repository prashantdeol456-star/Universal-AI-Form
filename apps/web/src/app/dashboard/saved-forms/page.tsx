import Link from "next/link";
import { IconBookmark, IconExternal } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { statusMeta, timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { listSavedForms } from "@/server/saved-forms/service";
import { AddSavedForm, EditNotes, RemoveSavedForm } from "./SavedFormsClient";

export default async function SavedFormsPage() {
  const user = await requirePageUser();
  const forms = await listSavedForms(user);

  return (
    <>
      <PageHeader
        title="Saved forms"
        description="Portals you apply on often. Open one, click the extension icon and your profile does the rest. You can also save a form from the extension."
        actions={forms.length > 0 ? <AddSavedForm /> : undefined}
      />

      {forms.length === 0 ? (
        <Card>
          <EmptyState icon={<IconBookmark size={22} />} title="No saved forms yet" action={<AddSavedForm />}>
            Save the registration pages you use, with notes like last date or fee.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {forms.map((f) => (
            <Card key={f.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-sm font-bold text-brand-700 uppercase" aria-hidden="true">
                    {f.domain.replace(/^www\./, "").slice(0, 2)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-gray-900">{f.name}</div>
                    <div className="truncate text-xs text-gray-500">{f.domain}</div>
                  </div>
                </div>
                <RemoveSavedForm id={f.id} name={f.name} />
              </div>
              <div className="mt-3 min-h-5">
                <EditNotes id={f.id} initial={f.notes} />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
                {f.lastApplication ? (
                  <Link href={`/dashboard/applications/${f.lastApplication.id}`} className="flex items-center gap-1.5 hover:text-gray-800">
                    <Badge tone={statusMeta(f.lastApplication.status).tone}>{statusMeta(f.lastApplication.status).label}</Badge>
                    {timeAgo(f.lastApplication.at)}
                    {f.applications > 1 && ` · ${f.applications} times`}
                  </Link>
                ) : (
                  <span>Not applied yet</span>
                )}
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:text-brand-700">
                  Open <IconExternal size={13} />
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
