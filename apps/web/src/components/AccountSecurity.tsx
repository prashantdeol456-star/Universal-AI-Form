"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { Alert, Button, Input, Label } from "./ui";

/** Turn two-step verification (authenticator app) on or off. */
export function MfaSettings({ enabled, recoveryLeft, required }: { enabled: boolean; recoveryLeft: number; required: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call<T>(body: Record<string, unknown>): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await api<T>("/api/account/mfa", { body });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return null;
    }
    return r.data;
  }

  if (codes) {
    return (
      <div className="space-y-3 text-sm">
        <Alert tone="green">Two-step verification is on.</Alert>
        <p className="text-gray-700">
          <b>Save these recovery codes</b> somewhere safe (not on this phone). Each works once if you lose your phone. They are not shown again.
        </p>
        <ul className="grid grid-cols-2 gap-1 rounded-xl bg-gray-50 p-3 font-mono text-sm sm:grid-cols-4">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          size="sm"
          onClick={() => {
            setCodes(null);
            router.refresh();
          }}
        >
          I have saved them
        </Button>
      </div>
    );
  }

  if (enabled) {
    return (
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if ((await call({ action: "disable", password, code })) !== null) router.refresh();
        }}
      >
        <p className="text-gray-700">
          <b className="text-emerald-700">On.</b> Signing in asks for a code from your authenticator app. {recoveryLeft} recovery code{recoveryLeft === 1 ? "" : "s"} left.
        </p>
        {required && <p className="text-xs text-amber-800">Required for your administrator account.</p>}
        <details>
          <summary className="cursor-pointer text-xs font-medium text-gray-500">Turn off</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" required autoComplete="current-password" />
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Current code" aria-label="Code" required inputMode="numeric" />
            <Button type="submit" variant="danger" size="sm" disabled={busy}>
              Turn off
            </Button>
          </div>
        </details>
        {error && <Alert>{error}</Alert>}
      </form>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-3 text-sm">
        {required && <Alert tone="amber">Administrator features need two-step verification. Turn it on to continue.</Alert>}
        <p className="text-gray-600">
          Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis…) in addition to your password.
        </p>
        <Button
          onClick={async () => {
            const r = await call<{ secret: string; uri: string }>({ action: "setup" });
            if (r) setSetup(r);
          }}
          disabled={busy}
        >
          Set up two-step verification
        </Button>
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await call<{ recoveryCodes: string[] }>({ action: "enable", password, code });
        if (r) setCodes(r.recoveryCodes);
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-gray-700">
        <li>In your authenticator app choose “Add account” → “Enter a setup key”.</li>
        <li>
          Account: your email · Key:{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[13px] break-all select-all">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code> · Time-based
        </li>
        <li>Enter the 6-digit code the app shows, and your password.</li>
      </ol>
      <p className="text-xs text-gray-500">
        Or open on the phone: <a href={setup.uri} className="text-brand-600 break-all hover:underline">otpauth link</a>
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="mfa-code">Code from the app</Label>
          <Input id="mfa-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} required autoComplete="one-time-code" />
        </div>
        <div>
          <Label htmlFor="mfa-pw">Password</Label>
          <Input id="mfa-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        <Button type="submit" disabled={busy}>
          Turn on
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

/** Schedule / cancel permanent account deletion. */
export function DeleteAccount({ scheduledFor, graceDays }: { scheduledFor: string | null; graceDays: number }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (scheduledFor) {
    return (
      <div className="space-y-3 text-sm">
        <Alert tone="red">
          Your account will be permanently deleted on <b>{new Date(scheduledFor).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</b>.
        </Alert>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await api("/api/account/deletion", { method: "DELETE" });
            setBusy(false);
            if (!r.ok) return setError(r.error.message);
            router.refresh();
          }}
        >
          Cancel deletion — keep my account
        </Button>
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }

  return (
    <form
      id="delete"
      className="space-y-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await api("/api/account/deletion", { body: { password } });
        setBusy(false);
        if (!r.ok) return setError(r.error.message);
        router.refresh();
      }}
    >
      <ul className="list-disc space-y-1 pl-5 text-gray-600">
        <li>
          <b>Right away:</b> other devices are signed out, café access ends, and anything you shared for learning is withdrawn.
        </li>
        <li>
          <b>After {graceDays} days:</b> your profile, documents (and files), chats, applications and learned mappings are deleted for good. You can cancel until then.
        </li>
        <li>Security logs keep a record that an account was deleted, without your details.</li>
      </ul>
      <p className="text-gray-600">
        Want a copy first? <a href="/api/privacy/export" className="font-medium text-brand-600 hover:underline">Download your data</a>.
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="del-confirm">Type DELETE to confirm</Label>
          <Input id="del-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="del-pw">Password</Label>
          <Input id="del-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        <Button type="submit" variant="danger" disabled={busy || confirmText !== "DELETE" || !password}>
          Delete my account
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

/** Mark all notifications read once the list has been seen. */
export function MarkAllRead({ unread }: { unread: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!unread) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api("/api/notifications", { body: { ids: "all" } });
        setBusy(false);
        router.refresh();
      }}
    >
      Mark all as read
    </Button>
  );
}
