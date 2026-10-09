import { MfaSettings } from "@/components/AccountSecurity";
import { SessionsList } from "@/components/SessionsList";
import { mfaStatus } from "@/server/auth/mfa";
import { Card } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { env } from "@/server/env";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { CloudAiToggle } from "./CloudAiToggle";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SettingsPage({ searchParams }: Props) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const mfa = await mfaStatus(user.id);
  const [pref] = await asUser(user, (tx) => tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${user.id}`);
  const e = env();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Your account, password, signed-in devices and AI preferences.</p>
      </div>
      <Card title="Account">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">Email</dt>
            <dd className="font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Email status</dt>
            <dd className="font-medium">{user.emailVerified ? "Verified" : "Not verified"}</dd>
          </div>
        </dl>
      </Card>
      <Card title="AI assistance">
        <CloudAiToggle initial={pref?.cloud_ai_enabled ?? true} available={e.GEMINI_ENABLED && Boolean(e.GEMINI_API_KEY)} />
      </Card>
      <section id="security">
        <Card title="Two-step verification">
          <MfaSettings enabled={mfa.enabled} recoveryLeft={mfa.recoveryCodesLeft} required={user.role === "SUPER_ADMIN" || sp.mfa === "required"} />
        </Card>
      </section>
      <Card title="Change password">
        <ChangePasswordForm />
      </Card>
      <Card title="Signed-in devices">
        <SessionsList />
      </Card>
    </>
  );
}
