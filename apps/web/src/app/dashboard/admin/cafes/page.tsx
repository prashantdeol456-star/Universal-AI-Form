import { IconStore } from "@/components/icons";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/labels";
import { listCafes } from "@/server/admin/cafes";
import { requirePageUser } from "@/server/auth/session";
import { ReasonAction } from "../AdminClient";

export default async function AdminCafesPage() {
  const user = await requirePageUser("admin:users_view");
  const cafes = await listCafes(user);
  return (
    <Card title={`${cafes.length} café${cafes.length === 1 ? "" : "s"}`}>
      {cafes.length === 0 ? (
        <EmptyState icon={<IconStore size={22} />} title="No cafés registered" />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="px-5 py-2 font-medium">Café</th>
                <th className="py-2 pr-4 font-medium">Owner</th>
                <th className="py-2 pr-4 text-right font-medium">Operators</th>
                <th className="py-2 pr-4 text-right font-medium">Sessions 30d</th>
                <th className="py-2 pr-4 text-right font-medium">Forms 30d</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-5 font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {cafes.map((c) => (
                <tr key={c.id} className="align-top">
                  <td className="px-5 py-2.5">
                    <div className="font-medium text-gray-900">{c.name}</div>
                    <div className="text-xs text-gray-500">
                      {c.city ?? "—"} · since {formatDate(c.createdAt)}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div>{c.ownerName}</div>
                    <div className="text-xs text-gray-500">{c.ownerEmail}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{c.operators}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {c.sessions30d}
                    {c.activeSessions > 0 && <div className="text-xs text-emerald-700">{c.activeSessions} live</div>}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{c.forms30d}</td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={c.status === "ACTIVE" ? "green" : "red"}>{c.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-5">
                    {c.status === "ACTIVE" ? (
                      <ReasonAction label="Suspend" url={`/api/admin/cafes/${c.id}`} body={{ status: "SUSPENDED" }} danger />
                    ) : (
                      <ReasonAction label="Reactivate" url={`/api/admin/cafes/${c.id}`} body={{ status: "ACTIVE" }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500">Suspending a café ends all its customer sessions immediately; operators can no longer read any customer data.</p>
    </Card>
  );
}
