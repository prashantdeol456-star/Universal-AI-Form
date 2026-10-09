import Link from "next/link";
import { USER_ROLES } from "@ufa/shared";
import { IconSearch } from "@/components/icons";
import { Badge, Button, ButtonLink, Card, Input, Select } from "@/components/ui";
import { formatDate, timeAgo } from "@/lib/labels";
import { listUsers } from "@/server/admin/users";
import { requirePageUser } from "@/server/auth/session";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AdminUsersPage({ searchParams }: Props) {
  const user = await requirePageUser("admin:users_view");
  const sp = await searchParams;
  const f = { q: one(sp.q), role: one(sp.role), status: one(sp.status), page: Number(one(sp.page)) || 1 };
  const r = await listUsers(user, f);
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  const qs = (page: number) => new URLSearchParams(Object.entries({ ...f, page: String(page) }).filter(([, v]) => v)).toString();

  return (
    <>
      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <div className="relative">
            <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <Input name="q" defaultValue={f.q} placeholder="Name or email" aria-label="Search users" className="pl-9" />
          </div>
          <Select name="role" defaultValue={f.role} aria-label="Role">
            <option value="">All roles</option>
            {USER_ROLES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={f.status} aria-label="Status">
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
          </Select>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card title={`${r.total} account${r.total === 1 ? "" : "s"}`}>
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="px-5 py-2 font-medium">Account</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Joined</th>
                <th className="py-2 pr-5 font-medium">Last sign-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {r.users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-5 py-2.5">
                    <Link href={`/dashboard/admin/users/${u.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                      {u.fullName}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {u.email}
                      {!u.emailVerified && " · not verified"}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={u.role === "SUPER_ADMIN" ? "red" : u.role.startsWith("CAFE") ? "amber" : "gray"}>{u.role}</Badge>
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={u.status === "ACTIVE" ? "green" : "red"}>{u.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-600">{formatDate(u.createdAt)}</td>
                  <td className="py-2.5 pr-5 text-gray-600">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
            <span className="text-gray-500">
              Page {r.page} of {pages}
            </span>
            <span className="flex gap-2">
              {r.page > 1 && <ButtonLink href={`?${qs(r.page - 1)}`} variant="secondary" size="sm">Previous</ButtonLink>}
              {r.page < pages && <ButtonLink href={`?${qs(r.page + 1)}`} variant="secondary" size="sm">Next</ButtonLink>}
            </span>
          </nav>
        )}
      </Card>
    </>
  );
}
