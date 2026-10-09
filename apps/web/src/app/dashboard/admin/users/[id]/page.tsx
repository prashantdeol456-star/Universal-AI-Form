import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { IconLock } from "@/components/icons";
import { Badge, Card } from "@/components/ui";
import { actionLabel, formatDateTime } from "@/lib/labels";
import { getUser } from "@/server/admin/users";
import { requirePageUser } from "@/server/auth/session";
import { HttpError } from "@/server/http";
import { ReasonAction } from "../../AdminClient";

type Props = { params: Promise<{ id: string }> };

export default async function AdminUserPage({ params }: Props) {
  const admin = await requirePageUser("admin:users_view");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  let u;
  try {
    u = await getUser(admin, id.data);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const self = u.id === admin.id;
  const isAdmin = u.role === "SUPER_ADMIN";
  const url = `/api/admin/users/${u.id}`;

  return (
    <>
      <Link href="/dashboard/admin/users" className="text-xs font-medium text-gray-500 hover:text-gray-800">
        ← All users
      </Link>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={u.fullName}>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">Email</dt>
              <dd>
                {u.email} {u.emailVerified ? <Badge tone="green">verified</Badge> : <Badge>not verified</Badge>}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Role · status</dt>
              <dd className="flex gap-1">
                <Badge tone={isAdmin ? "red" : "gray"}>{u.role}</Badge>
                <Badge tone={u.status === "ACTIVE" ? "green" : "red"}>{u.status}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Joined</dt>
              <dd>{formatDateTime(u.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Last sign-in</dt>
              <dd>{formatDateTime(u.lastLoginAt)}</dd>
            </div>
          </dl>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {[
              ["Profile fields", u.counts.profileFields],
              ["Documents", u.counts.documents],
              ["Applications", u.counts.applications],
              ["Signed-in devices", u.counts.activeSessions],
              ["Café sessions", u.counts.cafeSessions],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-xl bg-gray-50 p-2.5">
                <div className="text-lg font-semibold tabular-nums">{v}</div>
                <div className="text-xs text-gray-500">{k}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
            <IconLock size={13} /> Counts only. Admins cannot open this person&apos;s profile, documents, filled forms or chats.
          </p>
          {u.cafes.length > 0 && (
            <p className="mt-2 text-sm text-gray-600">
              Café: {u.cafes.map((c) => `${c.name} (${c.role.toLowerCase()}, ${c.status.toLowerCase()})`).join(", ")}
            </p>
          )}
        </Card>

        <Card title="Actions">
          {self || isAdmin ? (
            <p className="text-sm text-gray-500">{self ? "This is your own account." : "Administrator accounts are managed with the server CLI."}</p>
          ) : (
            <div className="space-y-3">
              {u.status === "ACTIVE" ? (
                <ReasonAction label="Suspend account" url={url} body={{ action: "suspend" }} danger />
              ) : (
                <ReasonAction label="Reactivate account" url={url} body={{ action: "reactivate" }} />
              )}
              <ReasonAction label="Sign out everywhere" url={url} body={{ action: "revoke_sessions" }} />
              <div className="space-y-2 border-t border-gray-100 pt-3">
                <div className="text-xs font-medium text-gray-500">Change role</div>
                {(["CUSTOMER", "CAFE_OWNER", "CAFE_OPERATOR"] as const)
                  .filter((r) => r !== u.role)
                  .map((r) => (
                    <ReasonAction key={r} label={`Make ${r.replace("_", " ").toLowerCase()}`} url={url} body={{ action: "set_role", role: r }} />
                  ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Recent account activity">
        {u.activity.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing recorded.</p>
        ) : (
          <ul className="-my-1 space-y-0.5 text-sm">
            {u.activity.map((a, i) => (
              <li key={i} className="flex justify-between gap-3 py-1">
                <span>
                  {actionLabel(a.action)} {a.byAdmin && <Badge tone="red">admin</Badge>}
                </span>
                <time className="text-xs text-gray-400" dateTime={a.at}>
                  {formatDateTime(a.at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
