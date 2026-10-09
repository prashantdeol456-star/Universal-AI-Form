import Link from "next/link";
import { IconDownload, IconHistory, IconSearch } from "@/components/icons";
import { Badge, Button, ButtonLink, Card, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { formatDateTime, statusMeta } from "@/lib/labels";
import { HISTORY_STATUSES, searchApplications } from "@/server/applications/history";
import { requirePageUser } from "@/server/auth/session";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function HistoryPage({ searchParams }: Props) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const filter = { q: one(sp.q), status: one(sp.status), from: one(sp.from), to: one(sp.to), page: Number(one(sp.page)) || 1 };
  const result = await searchApplications(user, { ...filter, pageSize: 20 });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const active = Boolean(filter.q || filter.status || filter.from || filter.to);

  const qs = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: filter.q, status: filter.status, from: filter.from, to: filter.to, ...extra })) if (v) p.set(k, String(v));
    return p.toString();
  };

  return (
    <>
      <PageHeader
        title="Application history"
        description="Every form you filled: search by form, website or application number."
        actions={
          <ButtonLink href={`/api/applications/export?${qs({})}`} variant="secondary" external>
            <IconDownload size={16} /> Export CSV
          </ButtonLink>
        }
      />

      <Card>
        <form method="get" className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          <div className="relative">
            <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <Input name="q" defaultValue={filter.q} placeholder="Search form, website or number" aria-label="Search" className="pl-9" />
          </div>
          <Select name="status" defaultValue={filter.status} aria-label="Status">
            <option value="">All statuses</option>
            {HISTORY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusMeta(s).label}
              </option>
            ))}
          </Select>
          <Input name="from" type="date" defaultValue={filter.from} aria-label="From date" />
          <Input name="to" type="date" defaultValue={filter.to} aria-label="To date" />
          <div className="flex gap-2">
            <Button type="submit">Filter</Button>
            {active && (
              <ButtonLink href="/dashboard/history" variant="ghost">
                Clear
              </ButtonLink>
            )}
          </div>
        </form>
      </Card>

      <Card title={`${result.total} application${result.total === 1 ? "" : "s"}${active ? " found" : ""}`}>
        {result.items.length === 0 ? (
          <EmptyState icon={<IconHistory size={22} />} title={active ? "No applications match" : "No applications yet"}>
            {active ? "Try a different search or clear the filters." : "Forms you fill with the Chrome extension appear here."}
          </EmptyState>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2 font-medium">Form</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Fields</th>
                  <th className="py-2 pr-4 font-medium">Application no.</th>
                  <th className="py-2 pr-5 font-medium">Filled on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.items.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5">
                      <Link href={`/dashboard/applications/${a.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                        {a.formName ?? a.domain}
                      </Link>
                      <div className="text-xs text-gray-500">{a.domain}</div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={statusMeta(a.status).tone}>{statusMeta(a.status).label}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 tabular-nums">
                      {a.filled === null ? a.fields : `${a.filled}/${a.fields}`}
                      {a.documents > 0 && <span className="ml-1 text-xs text-gray-400">· {a.documents} doc</span>}
                    </td>
                    <td className="py-2.5 pr-4">{a.applicationNumber ?? <span className="text-gray-400">—</span>}</td>
                    <td className="py-2.5 pr-5 whitespace-nowrap text-gray-600">{formatDateTime(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
            <span className="text-gray-500">
              Page {result.page} of {pages}
            </span>
            <span className="flex gap-2">
              {result.page > 1 && (
                <ButtonLink href={`/dashboard/history?${qs({ page: result.page - 1 })}`} variant="secondary" size="sm">
                  Previous
                </ButtonLink>
              )}
              {result.page < pages && (
                <ButtonLink href={`/dashboard/history?${qs({ page: result.page + 1 })}`} variant="secondary" size="sm">
                  Next
                </ButtonLink>
              )}
            </span>
          </nav>
        )}
      </Card>
    </>
  );
}
