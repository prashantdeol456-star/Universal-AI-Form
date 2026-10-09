"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

type LoginReply = { ok: boolean; mfaRequired?: boolean; mfaToken?: string };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Second step (two-step verification): the short-lived challenge from step 1.
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  const done = () => {
    router.replace("/dashboard");
    router.refresh();
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api<LoginReply>("/api/auth/login", { body: { email: form.get("email"), password: form.get("password"), client: "web" } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    if (res.data.mfaRequired && res.data.mfaToken) return setMfaToken(res.data.mfaToken);
    done();
  }

  async function onCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api("/api/auth/login/mfa", { body: { mfaToken, code: String(form.get("code") ?? ""), client: "web" } });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401 && /expired/i.test(res.error.message)) setMfaToken(null);
      return setError(res.error.message);
    }
    done();
  }

  if (mfaToken) {
    return (
      <>
        <h1 className="text-xl font-semibold">Two-step verification</h1>
        <p className="mt-1 text-sm text-gray-500">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
        <form onSubmit={onCode} className="mt-6 space-y-4">
          {error && <Alert>{error}</Alert>}
          <div>
            <Label htmlFor="code">Code</Label>
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={20} className="text-center font-mono text-lg tracking-[0.3em]" />
          </div>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Checking…" : "Verify"}
          </Button>
          <button type="button" className="w-full text-center text-xs text-gray-500 hover:text-gray-800" onClick={() => setMfaToken(null)}>
            Back
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-gray-500">Welcome back. Use your email and password.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="mb-1 text-xs text-brand-600 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-500">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
