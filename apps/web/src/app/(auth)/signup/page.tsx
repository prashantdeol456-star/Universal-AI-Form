"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setError("Passwords do not match");
    setBusy(true);
    setError(null);
    const res = await api("/api/auth/signup", {
      body: {
        fullName: form.get("fullName"),
        email: form.get("email"),
        password: form.get("password"),
        accountType: form.get("accountType"),
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-gray-500">One verified profile for every online form.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="fullName">Full name</Label>
          <Input id="fullName" name="fullName" autoComplete="name" required maxLength={200} />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <Label htmlFor="password" hint="(min 10 chars, a letter and a digit)">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        </div>
        <div>
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} />
        </div>
        <div>
          <Label htmlFor="accountType">Account type</Label>
          <Select id="accountType" name="accountType" defaultValue="CUSTOMER">
            <option value="CUSTOMER">Individual — fill my own forms</option>
            <option value="CAFE_OWNER">Cyber café owner</option>
          </Select>
        </div>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-500">
        Already registered?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
