"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

export default function ForgotPasswordPage() {
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const res = await api<{ message: string }>("/api/auth/forgot-password", { body: { email: form.get("email") } });
    setBusy(false);
    setMessage(res.ok ? { tone: "green", text: res.data.message } : { tone: "red", text: res.error.message });
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-gray-500">We will email you a link to choose a new password.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
