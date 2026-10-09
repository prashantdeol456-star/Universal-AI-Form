"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input } from "@/components/ui";
import { api } from "@/lib/api-client";

const TABS = [
  { href: "/dashboard/admin", label: "Overview" },
  { href: "/dashboard/admin/users", label: "Users" },
  { href: "/dashboard/admin/cafes", label: "Cafés" },
  { href: "/dashboard/admin/learning", label: "Learning review" },
  { href: "/dashboard/admin/models", label: "Models" },
  { href: "/dashboard/admin/audit", label: "Audit log" },
];

export function AdminTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Admin sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-gray-200 pb-px">
      {TABS.map((t) => {
        const active = t.href === "/dashboard/admin" ? path === t.href : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${active ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A guarded admin action: asks for a reason (kept in the audit log) before
 * calling the API. Destructive actions are shown in red.
 */
export function ReasonAction({
  label,
  url,
  method = "PATCH",
  body,
  danger = false,
  needsReason = true,
  confirmText,
  size = "sm",
  reasonField = "reason",
}: {
  label: string;
  url: string;
  method?: "PATCH" | "POST";
  body: Record<string, unknown>;
  danger?: boolean;
  needsReason?: boolean;
  confirmText?: string;
  size?: "sm" | "md";
  /** Body field the reason is sent in. */
  reasonField?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ result?: { servingName?: string | null; to?: string; from?: string } }>(url, { method, body: needsReason ? { ...body, [reasonField]: reason } : body });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error.message });
    const serving = r.data?.result?.servingName;
    setMsg({ ok: true, text: serving !== undefined ? `Done. Nothing was deployed — set LOCAL_AI_MODEL=${serving} and restart the web container to serve it.` : "Done." });
    setOpen(false);
    setReason("");
    router.refresh();
  }

  if (!open) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <Button variant={danger ? "danger" : "secondary"} size={size} onClick={() => (needsReason ? setOpen(true) : confirm(confirmText ?? `${label}?`) && run())} disabled={busy}>
          {label}
        </Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
      </span>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (kept in the audit log)" aria-label="Reason" className="max-w-64" minLength={3} maxLength={300} required autoFocus />
      <Button type="submit" size="sm" variant={danger ? "danger" : "primary"} disabled={busy || reason.trim().length < 3}>
        Confirm
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {msg && !msg.ok && <Alert>{msg.text}</Alert>}
    </form>
  );
}
