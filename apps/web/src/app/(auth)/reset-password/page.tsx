"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setError("Passwords do not match");
    setBusy(true);
    setError(null);
    const res = await api("/api/auth/reset-password", { body: { token, password: form.get("password") } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setDone(true);
  }

  if (!token) return <Alert>This reset link is incomplete. Request a new one from the sign-in page.</Alert>;
  if (done)
    return (
      <div className="space-y-4">
        <Alert tone="green">Password updated. All other sessions were signed out.</Alert>
        <Link href="/login" className="block text-center text-sm font-medium text-brand-600 hover:underline">
          Sign in with your new password
        </Link>
      </div>
    );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <Label htmlFor="password" hint="(min 10 chars, a letter and a digit)">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
      </div>
      <div>
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} />
      </div>
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">Choose a new password</h1>
      <Suspense>
        <ResetForm />
      </Suspense>
    </>
  );
}
