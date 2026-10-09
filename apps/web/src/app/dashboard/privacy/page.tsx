import { DeleteAccount } from "@/components/AccountSecurity";
import { SessionsList } from "@/components/SessionsList";
import { env } from "@/server/env";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { asUser } from "@/server/db";

export default async function PrivacyPage() {
  const user = await requirePageUser("privacy:manage_own");
  const { cafeSessions, access, counts, ai } = await asUser(user, async (tx) => {
    const cafeSessions = await tx<{ id: string; cafe_name: string | null; status: string; expires_at: Date; created_at: Date }[]>`
      select s.id, c.name as cafe_name, s.status, s.expires_at, s.created_at
        from cafe_sessions s left join cafes c on c.id = s.cafe_id
       where s.customer_id = ${user.id} order by s.created_at desc limit 20`;
    const access = await tx<{ action: string; actor_role: string | null; actor_is_me: boolean; created_at: Date }[]>`
      select action, actor_role, (actor_id = ${user.id}) as actor_is_me, created_at
        from audit_logs where subject_user_id = ${user.id}
       order by created_at desc limit 25`;
    const [counts] = (await tx`
      select (select count(*) from profile_fields where user_id = ${user.id} and deleted_at is null)::int as fields,
             (select count(*) from documents where user_id = ${user.id} and deleted_at is null)::int as documents,
             (select count(*) from applications where customer_id = ${user.id})::int as applications,
             (select count(*) from ai_requests where user_id = ${user.id} and provider = 'gemini')::int as gemini`) as unknown as [
      { fields: number; documents: number; applications: number; gemini: number },
    ];
    const [ai] = (await tx`
      select (select count(*) from ai_requests where user_id = ${user.id} and provider = 'local')::int as local_calls,
             (select count(*) from ai_requests where user_id = ${user.id} and provider = 'gemini' and created_at >= date_trunc('month', now()))::int as gemini_calls_month,
             (select coalesce(sum(items), 0) from ai_requests where user_id = ${user.id} and provider = 'gemini' and created_at >= date_trunc('month', now()))::int as gemini_fields_month,
             (select count(*) from ai_field_suggestions where user_id = ${user.id} and user_confirmed)::int as confirmed,
             (select count(*) from ai_field_suggestions where user_id = ${user.id} and user_corrected)::int as corrected,
             (select cloud_ai_enabled from profiles where user_id = ${user.id}) as cloud_ai_enabled`) as unknown as [
      { local_calls: number; gemini_calls_month: number; gemini_fields_month: number; confirmed: number; corrected: number; cloud_ai_enabled: boolean | null },
    ];
    return { cafeSessions, access, counts, ai };
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Privacy & Access</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">See what is stored, who can access it, and take a copy of your data.</p>
      </div>

      <Card title="What we store">
        <ul className="grid gap-3 text-sm sm:grid-cols-4">
          <li><div className="text-2xl font-semibold tracking-tight text-gray-900">{counts.fields}</div><div className="text-gray-500">profile values</div></li>
          <li><div className="text-2xl font-semibold tracking-tight text-gray-900">{counts.documents}</div><div className="text-gray-500">documents</div></li>
          <li><div className="text-2xl font-semibold tracking-tight text-gray-900">{counts.applications}</div><div className="text-gray-500">applications</div></li>
          <li><div className="text-2xl font-semibold tracking-tight text-gray-900">{counts.gemini}</div><div className="text-gray-500">requests sent to Gemini</div></li>
        </ul>
        <p className="mt-4 text-xs text-gray-500">
          Aadhaar, PAN, passport, bank and other sensitive values are encrypted with AES-256-GCM before they reach the database.
        </p>
      </Card>

      <Card
        title="AI processing"
        actions={
          <Link href="/dashboard/settings" className="text-sm font-medium text-brand-600 hover:underline">
            Change
          </Link>
        }
      >
        <p className="text-sm text-gray-700">
          Cloud AI (Google Gemini) is <b>{ai.cloud_ai_enabled === false ? "off" : "on"}</b> for your account. It is only asked about form
          fields that the built-in rules, your past confirmations and the local model could not recognise.
        </p>
        <ul className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
          <li><div className="text-xl font-semibold">{ai.gemini_calls_month}</div><div className="text-gray-500">Gemini requests this month</div></li>
          <li><div className="text-xl font-semibold">{ai.gemini_fields_month}</div><div className="text-gray-500">field labels sent this month</div></li>
          <li><div className="text-xl font-semibold">{ai.confirmed} / {ai.corrected}</div><div className="text-gray-500">suggestions you confirmed / corrected</div></li>
          <li><div className="text-xl font-semibold">{ai.local_calls}</div><div className="text-gray-500">requests to the local model (on this server)</div></li>
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Sent to Gemini: a field&apos;s label, section, input type and option names. Never sent: your profile values, documents,
          chat messages, the page address or the page content.
        </p>
      </Card>

      <Card
        title="Export your data"
        actions={
          <a href="/api/privacy/export" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            Download JSON
          </a>
        }
      >
        <p className="text-sm text-gray-600">
          A complete machine-readable copy of your profile (including decrypted sensitive values), documents list, applications,
          sessions and access history. Keep the file safe.
        </p>
      </Card>

      <Card title="Cyber café access">
        {cafeSessions.length === 0 ? (
          <p className="text-sm text-gray-500">No café has ever requested access to your data.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {cafeSessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span>{s.cafe_name ?? "Café"}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={s.status === "ACTIVE" ? "green" : "gray"}>{s.status}</Badge>
                  <span className="text-xs text-gray-500">until {s.expires_at.toLocaleString("en-IN")}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-gray-500">
          Approve, stop and audit café access in <Link href="/dashboard/cafe-access" className="text-brand-600 hover:underline">Café access</Link>.
        </p>
      </Card>

      <Card title="Signed-in devices">
        <SessionsList />
      </Card>

      <Card title="Access history">
        {access.length === 0 ? (
          <p className="text-sm text-gray-500">No events yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {access.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <code className="text-xs">{a.action}</code>{" "}
                  <span className="text-xs text-gray-500">by {a.actor_is_me ? "you" : a.actor_role ?? "system"}</span>
                </span>
                <time className="text-xs text-gray-500">{a.created_at.toLocaleString("en-IN")}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Delete account">
        {user.role === "SUPER_ADMIN" ? (
          <p className="text-sm text-gray-600">Administrator accounts are removed with the server CLI.</p>
        ) : (
          <DeleteAccount scheduledFor={user.deletionScheduledFor} graceDays={env().ACCOUNT_DELETION_GRACE_DAYS} />
        )}
      </Card>
    </>
  );
}
