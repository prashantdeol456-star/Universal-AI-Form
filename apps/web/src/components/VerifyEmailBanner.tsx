"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api-client";
import { Alert, Button, Input } from "./ui";

export function VerifyEmailBanner({ email }: { email: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    setBusy(true);
    const res = await api("/api/auth/verify-email", { body: { code } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    router.refresh();
  }

  async function resend() {
    const res = await api("/api/auth/verify-email/resend", { method: "POST" });
    setMsg(res.ok ? { tone: "green", text: "A new code has been sent." } : { tone: "red", text: res.error.message });
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        Verify your email <strong>{email}</strong>. Enter the 6-digit code we sent you.
      </p>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
        <Input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required placeholder="123456" className="w-32" aria-label="Verification code" />
        <Button type="submit" size="sm" disabled={busy}>
          Verify
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={resend}>
          Resend code
        </Button>
      </form>
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </div>
  );
}
