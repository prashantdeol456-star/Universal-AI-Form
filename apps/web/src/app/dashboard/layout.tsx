import Link from "next/link";
import { IconBell, IconPuzzle } from "@/components/icons";
import { Logo } from "@/components/Logo";
import { LogoutButton } from "@/components/LogoutButton";
import { navFor } from "@/components/nav";
import { SidebarNav } from "@/components/SidebarNav";
import { VerifyEmailBanner } from "@/components/VerifyEmailBanner";
import { requirePageUser } from "@/server/auth/session";
import { unreadCount } from "@/server/notifications";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  CAFE_OWNER: "Café owner",
  CAFE_OPERATOR: "Café operator",
  CUSTOMER: "Customer",
  ENTERPRISE_ADMIN: "Enterprise admin",
  ENTERPRISE_USER: "Enterprise user",
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const unread = await unreadCount(user).catch(() => 0);
  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-gray-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between px-5 py-4">
          <Logo />
        </div>
        <div className="lg:flex-1 lg:overflow-y-auto lg:pt-2">
          <SidebarNav items={navFor(user.role)} />
        </div>
        <div className="hidden p-3 lg:block">
          <div className="rounded-xl bg-gradient-to-br from-brand-50 to-indigo-50 p-3.5 ring-1 ring-brand-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand-700">
              <IconPuzzle size={16} /> Chrome extension
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">Open any form, click the extension icon and choose <b>Analyze form</b>. Nothing is filled until you confirm.</p>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center justify-end gap-3 border-b border-gray-200 bg-white/85 px-4 py-2.5 backdrop-blur sm:px-8">
          <Link
            href="/dashboard/notifications"
            className="relative grid size-9 place-items-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          >
            <IconBell size={19} />
            {unread > 0 && (
              <span className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] leading-4 font-semibold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-white" aria-hidden="true">
              {initials(user.fullName) || "?"}
            </span>
            <div className="text-sm leading-tight">
              <div className="font-medium text-gray-900">{user.fullName}</div>
              <div className="text-xs text-gray-500">{ROLE_LABEL[user.role] ?? user.role}</div>
            </div>
          </div>
          <span className="h-6 w-px bg-gray-200" aria-hidden="true" />
          <LogoutButton />
        </header>
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
          {user.deletionScheduledFor && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span>
                This account will be permanently deleted on{" "}
                <b>{new Date(user.deletionScheduledFor).toLocaleDateString("en-IN", { dateStyle: "medium" })}</b>.
              </span>
              <Link href="/dashboard/privacy#delete" className="font-semibold underline">
                Cancel deletion
              </Link>
            </div>
          )}
          {!user.emailVerified && <VerifyEmailBanner email={user.email} />}
          {children}
        </main>
      </div>
    </div>
  );
}
