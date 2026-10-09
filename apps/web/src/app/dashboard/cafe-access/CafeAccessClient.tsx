"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CAFE_PERMISSION_LABELS, CAFE_SESSION_DURATIONS, DEFAULT_CAFE_PERMISSIONS, type CafePermission } from "@ufa/shared/cafe";
import { IconLock } from "@/components/icons";
import { Alert, Button, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";

const ALL: CafePermission[] = ["basic_profile", "contact", "family", "education", "employment", "recruitment", "identity", "documents", "applications", "custom"];

export const durationLabel = (m: number) => (m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`);

function PermissionPicker({ value, onChange, allowed }: { value: CafePermission[]; onChange: (v: CafePermission[]) => void; allowed?: CafePermission[] }) {
  const list = allowed ?? ALL;
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">What to share</legend>
      {list.map((p) => {
        const l = CAFE_PERMISSION_LABELS[p];
        const on = value.includes(p);
        return (
          <label key={p} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 text-sm ${on ? "border-brand-200 bg-brand-50/50" : "border-gray-200"}`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-brand-600"
              checked={on}
              onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
            />
            <span>
              <span className="font-medium text-gray-900">
                {l.en} <span className="font-normal text-gray-400">· {l.hi}</span>
              </span>
              <span className="block text-xs text-gray-500">{l.hint}</span>
            </span>
          </label>
        );
      })}
      <p className="flex items-center gap-1.5 text-xs text-gray-500 sm:col-span-2">
        <IconLock size={13} /> Bank details are never shared with a café.
      </p>
    </fieldset>
  );
}

function DurationSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="How long">
      {CAFE_SESSION_DURATIONS.map((m) => (
        <option key={m} value={m}>
          {durationLabel(m)}
        </option>
      ))}
    </Select>
  );
}

/** Approve a café's request with exactly what you want to share. */
export function ApproveRequest({ id, requested }: { id: string; requested: CafePermission[] }) {
  const router = useRouter();
  const [perms, setPerms] = useState<CafePermission[]>(requested.filter((p) => p !== "identity" && p !== "documents"));
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const r = await api(`/api/cafe-access/sessions/${id}`, { body: action === "approve" ? { action, permissions: perms, durationMinutes: minutes } : { action } });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <PermissionPicker value={perms} onChange={setPerms} allowed={requested} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Label>For how long</Label>
          <DurationSelect value={minutes} onChange={setMinutes} />
        </div>
        <Button onClick={() => act("approve")} disabled={busy || perms.length === 0}>
          Allow access
        </Button>
        <Button variant="secondary" onClick={() => act("reject")} disabled={busy}>
          Reject
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function RevokeSession({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api(`/api/cafe-access/sessions/${id}`, { body: { action: "revoke" } });
        setBusy(false);
        router.refresh();
      }}
    >
      Stop access now
    </Button>
  );
}

/** Make a one-time code to read out to the operator. */
export function CodeGenerator() {
  const router = useRouter();
  const [perms, setPerms] = useState<CafePermission[]>(DEFAULT_CAFE_PERMISSIONS);
  const [minutes, setMinutes] = useState(60);
  const [purpose, setPurpose] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(code.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [code]);

  async function create() {
    setBusy(true);
    setError(null);
    const r = await api<{ code: string; expiresAt: string }>("/api/cafe-access/codes", { body: { permissions: perms, durationMinutes: minutes, purpose: purpose || null } });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setCode(r.data);
    router.refresh();
  }

  if (code && left > 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-gray-600">Read this code to the café operator. It works once.</p>
        <div className="font-mono text-4xl font-bold tracking-[0.2em] text-gray-900 select-all" aria-live="polite">
          {code.code}
        </div>
        <p className="text-xs text-gray-500">
          Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} · access lasts {durationLabel(minutes)} after it is used
        </p>
        <Button variant="ghost" size="sm" onClick={() => setCode(null)}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PermissionPicker value={perms} onChange={setPerms} />
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
        <div>
          <Label>Access lasts</Label>
          <DurationSelect value={minutes} onChange={setMinutes} />
        </div>
        <div>
          <Label hint="(optional)">For</Label>
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} placeholder="e.g. SSC CGL form" />
        </div>
        <Button onClick={create} disabled={busy || perms.length === 0}>
          Create code
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
