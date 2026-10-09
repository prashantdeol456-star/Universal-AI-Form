"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CAFE_PERMISSION_LABELS, DEFAULT_CAFE_PERMISSIONS, type CafePermission } from "@ufa/shared/cafe";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

const ALL: CafePermission[] = ["basic_profile", "contact", "family", "education", "employment", "recruitment", "identity", "documents", "applications", "custom"];

export function CreateCafeForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", phone: "", address: "", city: "", state: "", pincode: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await api("/api/cafe", { body: f });
        setBusy(false);
        if (!r.ok) return setError(r.error.message);
        router.refresh();
      }}
    >
      <div className="sm:col-span-2">
        <Label htmlFor="c-name">Café name</Label>
        <Input id="c-name" value={f.name} onChange={set("name")} required minLength={2} maxLength={200} placeholder="e.g. Sharma Cyber Café" />
      </div>
      <div>
        <Label htmlFor="c-phone" hint="(optional)">Phone</Label>
        <Input id="c-phone" value={f.phone} onChange={set("phone")} inputMode="tel" maxLength={20} />
      </div>
      <div>
        <Label htmlFor="c-city" hint="(optional)">City</Label>
        <Input id="c-city" value={f.city} onChange={set("city")} maxLength={100} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="c-addr" hint="(optional)">Address</Label>
        <Input id="c-addr" value={f.address} onChange={set("address")} maxLength={500} />
      </div>
      <div>
        <Label htmlFor="c-state" hint="(optional)">State</Label>
        <Input id="c-state" value={f.state} onChange={set("state")} maxLength={100} />
      </div>
      <div>
        <Label htmlFor="c-pin" hint="(optional)">PIN code</Label>
        <Input id="c-pin" value={f.pincode} onChange={set("pincode")} inputMode="numeric" maxLength={6} pattern="\d{6}" />
      </div>
      {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy}>Register café</Button>
      </div>
    </form>
  );
}

/** Operator enters the customer's one-time code. */
export function RedeemCode() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const r = await api<{ customerName: string; expiresAt: string }>("/api/cafe/sessions/redeem", { body: { code } });
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error.message });
        setCode("");
        setMsg({ ok: true, text: `Session started for ${r.data.customerName}. Open the form and use the extension in café mode.` });
        router.refresh();
      }}
    >
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        aria-label="Customer code"
        className="font-mono text-lg tracking-[0.2em]"
        maxLength={12}
        autoComplete="off"
        required
      />
      <Button type="submit" disabled={busy || code.replace(/[\s-]/g, "").length < 8}>
        Start session
      </Button>
      {msg && <Alert tone={msg.ok ? "green" : "red"}>{msg.text}</Alert>}
    </form>
  );
}

/** Ask a registered customer for access (they approve on their phone). */
export function RequestAccess() {
  const [identifier, setIdentifier] = useState("");
  const [purpose, setPurpose] = useState("");
  const [perms, setPerms] = useState<CafePermission[]>(DEFAULT_CAFE_PERMISSIONS);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const r = await api("/api/cafe/sessions/request", { body: { identifier, permissions: perms, purpose: purpose || null } });
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error.message });
        setMsg({ ok: true, text: "If this person has an account, they now see your request in their dashboard. It appears under Active sessions once they approve." });
        setIdentifier("");
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="Customer's email or mobile" aria-label="Customer email or mobile" required />
        <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose (e.g. SSC form)" aria-label="Purpose" maxLength={200} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ALL.map((p) => {
          const on = perms.includes(p);
          return (
            <button
              type="button"
              key={p}
              onClick={() => setPerms(on ? perms.filter((x) => x !== p) : [...perms, p])}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${on ? "bg-brand-50 text-brand-700 ring-brand-200" : "text-gray-500 ring-gray-200"}`}
              aria-pressed={on}
            >
              {CAFE_PERMISSION_LABELS[p].en}
            </button>
          );
        })}
      </div>
      <Button type="submit" variant="secondary" disabled={busy || perms.length === 0}>
        Send request
      </Button>
      {msg && <Alert tone={msg.ok ? "blue" : "red"}>{msg.text}</Alert>}
    </form>
  );
}

export function EndSession({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await api(`/api/cafe/sessions/${id}/end`, { method: "POST" });
        router.refresh();
      }}
    >
      End
    </Button>
  );
}

export function InviteOperator() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const r = await api("/api/cafe/operators", { body: { fullName, email } });
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error.message });
        setMsg({ ok: true, text: `Invitation sent to ${email}. They set their own password from the e-mail.` });
        setFullName("");
        setEmail("");
        router.refresh();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Operator name" aria-label="Operator name" required maxLength={200} />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Work email" aria-label="Operator email" type="email" required />
        <Button type="submit" disabled={busy}>Invite</Button>
      </div>
      {msg && <Alert tone={msg.ok ? "green" : "red"}>{msg.text}</Alert>}
    </form>
  );
}

/** Owner closes the café for good (needed before deleting the owner account). */
export function CloseCafe() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={busy}
      onClick={async () => {
        if (!confirm("Close this café permanently? All customer sessions end and operators lose access. Customers keep their application history.")) return;
        setBusy(true);
        await api("/api/cafe/close", { method: "POST" });
        setBusy(false);
        router.refresh();
      }}
    >
      Close café
    </Button>
  );
}

export function OperatorToggle({ id, status }: { id: string; status: "ACTIVE" | "DISABLED" }) {
  const router = useRouter();
  const next = status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  return (
    <Button
      variant={status === "ACTIVE" ? "danger" : "secondary"}
      size="sm"
      onClick={async () => {
        if (next === "DISABLED" && !confirm("Disable this operator? Their open customer sessions end immediately.")) return;
        await api(`/api/cafe/operators/${id}`, { method: "PATCH", body: { status: next } });
        router.refresh();
      }}
    >
      {status === "ACTIVE" ? "Disable" : "Enable"}
    </Button>
  );
}
