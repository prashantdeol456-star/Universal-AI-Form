import { IconSearch } from "@/components/icons";
import { Badge, Button, ButtonLink, Card, Input } from "@/components/ui";
import { actionLabel, formatDateTime } from "@/lib/labels";
import { searchAudit } from "@/server/admin/audit-log";
import { requirePageUser } from "@/server/auth/session";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AdminAuditPage({ searchParams }: Props) {
  const user = await requirePageUser("admin:audit_view");
  const sp = await searchParams;
  const f = { action: one(sp.action), user: one(sp.user), page: Number(one(sp.page)) || 1 };
  const r = await searchAudit(user, f);
  const qs = (page: number) => new URLSearchParams(Object.entries({ ...f, page: String(page) }).filter(([, v]) => v)).toString();

  return (
    <>
      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Input name="action" defaultValue={f.action} placeholder="Action starts with (e.g. admin. or cafe.)" aria-label="Action prefix" />
          <div className="relative">
            <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <Input name="user" defaultValue={f.user} placeholder="Actor or subject email" aria-label="User email" className="pl-9" />
          </div>
          <Button type="submit">Filter</Button>
        </form>
      </Card>
      <Card title="Audit log">
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="px-5 py-2 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">What</th>
                <th className="py-2 pr-4 font-medium">By</th>
                <th className="py-2 pr-4 font-medium">About</th>
                <th className="py-2 pr-5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {r.rows.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="px-5 py-2 text-xs whitespace-nowrap text-gray-500">{formatDateTime(l.at)}</td>
                  <td className="py-2 pr-4">
                    <div>{actionLabel(l.action)}</div>
                    <code className="text-[11px] text-gray-400">{l.action}</code>
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {l.actorEmail ?? "system"} {l.actorRole === "SUPER_ADMIN" && <Badge tone="red">admin</Badge>}
                    {l.ip && <div className="text-gray-400">{l.ip}</div>}
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {l.subjectEmail ?? "—"}
                    {l.cafeName && <div className="text-gray-400">café: {l.cafeName}</div>}
                  </td>
                  <td className="py-2 pr-5">
                    {Object.keys(l.metadata ?? {}).length > 0 && (
                      <code className="block max-w-xs truncate text-[11px] text-gray-500" title={JSON.stringify(l.metadata)}>
                        {JSON.stringify(l.metadata)}
                      </code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <nav className="mt-4 flex justify-end gap-2" aria-label="Pagination">
          {r.page > 1 && <ButtonLink href={`?${qs(r.page - 1)}`} variant="secondary" size="sm">Newer</ButtonLink>}
          {r.hasMore && <ButtonLink href={`?${qs(r.page + 1)}`} variant="secondary" size="sm">Older</ButtonLink>}
        </nav>
      </Card>
    </>
  );
}
