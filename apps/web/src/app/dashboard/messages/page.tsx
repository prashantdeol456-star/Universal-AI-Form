import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { gmailStatus } from "@/server/messaging/gmail";
import { listChats, whatsappCapabilities } from "@/server/messaging/whatsapp";
import { GmailPanel } from "./GmailPanel";
import { WhatsAppPanel } from "./WhatsAppPanel";

const REASONS: Record<string, string> = {
  access_denied: "You did not allow access to Gmail.",
  invalid_state: "That sign-in link was not valid for your account. Start again.",
  state_used: "That sign-in link was already used. Start again.",
  state_expired: "The sign-in took too long. Start again.",
  scope_missing: "Read access to Gmail was not granted, so Gmail was not connected.",
  no_refresh_token: "Google did not give long-term access. Remove the app at myaccount.google.com/permissions and connect again.",
};

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const tab = sp.tab === "whatsapp" ? "whatsapp" : "email";
  const notice = sp.gmail === "connected" ? "Connected to Gmail." : sp.gmail === "error" ? `Gmail was not connected: ${REASONS[sp.reason ?? ""] ?? "something went wrong. Try again."}` : null;
  const [status, chats, jobs] = await Promise.all([
    gmailStatus(user),
    tab === "whatsapp" ? listChats(user) : Promise.resolve([]),
    asUser(user, (tx) => tx<{ id: string; title: string }[]>`
      select j.id, j.title from job_listings j join job_saves s on s.job_id = j.id where j.user_id = ${user.id} order by s.saved_at desc limit 50`),
  ]);
  return (
    <>
      <PageHeader
        title="Messages"
        description="Summaries and reply drafts for your email and WhatsApp conversations. Nothing is ever sent for you: email replies become Gmail drafts only after you approve them, and WhatsApp replies are copied by you."
      />
      <nav className="flex gap-1.5" aria-label="Channels">
        {(["email", "whatsapp"] as const).map((t) => (
          <Link
            key={t}
            href={`/dashboard/messages?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${tab === t ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700 hover:bg-gray-50"}`}
          >
            {t === "email" ? "Email (Gmail)" : "WhatsApp"}
          </Link>
        ))}
      </nav>
      {tab === "email" ? <GmailPanel status={status} notice={notice} jobs={jobs} /> : <WhatsAppPanel caps={whatsappCapabilities()} chats={chats} />}
    </>
  );
}
