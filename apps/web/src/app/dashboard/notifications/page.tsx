import Link from "next/link";
import { MarkAllRead } from "@/components/AccountSecurity";
import { IconBell } from "@/components/icons";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { listNotifications } from "@/server/notifications";

export default async function NotificationsPage() {
  const user = await requirePageUser();
  const { items, unread } = await listNotifications(user, 100);
  return (
    <>
      <PageHeader title="Notifications" description="Café requests, documents read, new sign-ins and other updates about your account." actions={<MarkAllRead unread={unread} />} />
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={<IconBell size={22} />} title="Nothing yet" />
        ) : (
          <ul className="-my-2 divide-y divide-gray-100">
            {items.map((n) => {
              const content = (
                <>
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-brand-500"}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${n.read ? "text-gray-700" : "font-semibold text-gray-900"}`}>{n.title}</span>
                    {n.body && <span className="block text-xs text-gray-500">{n.body}</span>}
                  </span>
                  <time className="shrink-0 text-xs text-gray-400" dateTime={n.createdAt}>
                    {timeAgo(n.createdAt)}
                  </time>
                </>
              );
              return (
                <li key={n.id}>
                  {n.link?.startsWith("/") ? (
                    <Link href={n.link} className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-3 hover:bg-gray-50">
                      {content}
                    </Link>
                  ) : (
                    <div className="flex items-start gap-3 py-3">{content}</div>
                  )}
                  {!n.read && <span className="sr-only">unread</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
