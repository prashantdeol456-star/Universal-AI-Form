"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

export function ChangePasswordForm() {
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    if (form.get("newPassword") !== form.get("confirm")) return setMsg({ tone: "red", text: "New passwords do not match" });
    setBusy(true);
    const res = await api("/api/account/password", {
      body: { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") },
    });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    formEl.reset();
    setMsg({ tone: "green", text: "Password changed. Your other sessions were signed out." });
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-md gap-3">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div>
        <Label htmlFor="currentPassword">Current password</Label>
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </div>
      <div>
        <Label htmlFor="newPassword" hint="(min 10 chars, a letter and a digit)">New password</Label>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={10} />
      </div>
      <div>
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} />
      </div>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
