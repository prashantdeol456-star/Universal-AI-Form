"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { IconSearch, IconTrash } from "@/components/icons";
import { Alert, Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api-client";

export function ContributionToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const r = await api<{ contributionEnabled: boolean }>("/api/learning", { method: "PATCH", body: { contributionEnabled: next } });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setEnabled(r.data.contributionEnabled);
    router.refresh();
  }

  async function withdraw() {
    if (!confirm("Stop contributing and withdraw everything you contributed so far? Your own mappings keep working for you.")) return;
    setBusy(true);
    const r = await api<{ withdrawn: number }>("/api/learning/withdraw", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setEnabled(false);
    setNotice(`Withdrawn: ${r.data.withdrawn} example${r.data.withdrawn === 1 ? "" : "s"}. Shared patterns that relied on you are recalculated shortly.`);
    router.refresh();
  }

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span>
          <span className="font-medium text-gray-900">Help improve matching for everyone</span>
          <span className="block text-gray-500">
            Shares only which <i>field label</i> maps to which <i>profile field</i> on a website (for example “पिता का नाम” → Father’s Name) —
            never your values, documents or identity. A pattern becomes shared only after several different people confirm it.
          </span>
        </span>
      </label>
      <button className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50" onClick={withdraw} disabled={busy}>
        Withdraw all my contributions
      </button>
      {notice && <Alert tone="green">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export interface MappingRow {
  id: string;
  domain: string | null;
  label: string;
  profileFieldLabel: string;
  verified: boolean;
  successCount: number;
  failureCount: number;
  source: string | null;
}

const SOURCE: Record<string, string> = { user: "You confirmed", application: "Used in a form you filled" };

export function MappingsTable({ rows }: { rows: MappingRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => !removed.has(r.id) && (!s || `${r.label} ${r.domain ?? ""} ${r.profileFieldLabel}`.toLowerCase().includes(s)));
  }, [rows, q, removed]);

  async function forget(id: string) {
    setError(null);
    const r = await api(`/api/learning/mappings/${id}`, { method: "DELETE" });
    if (!r.ok) return setError(r.error.message);
    setRemoved((prev) => new Set(prev).add(id));
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search label, website or field" aria-label="Search mappings" className="pl-9" />
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr className="border-b border-gray-100">
              <th className="px-5 py-2 font-medium">Label on the website</th>
              <th className="py-2 pr-4 font-medium">Goes to</th>
              <th className="py-2 pr-4 font-medium">Learned from</th>
              <th className="py-2 pr-5 text-right font-medium">
                <span className="sr-only">Forget</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.map((r) => {
              const wrong = r.failureCount > r.successCount;
              return (
                <tr key={r.id}>
                  <td className="px-5 py-2.5">
                    <div className="font-medium text-gray-900">{r.label}</div>
                    <div className="text-xs text-gray-500">{r.domain ?? "any website"}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    {wrong ? (
                      <span className="text-gray-500 line-through">{r.profileFieldLabel}</span>
                    ) : (
                      <span className="text-gray-800">{r.profileFieldLabel}</span>
                    )}
                    {wrong && <Badge tone="red">marked wrong</Badge>}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-gray-500">
                    {SOURCE[r.source ?? ""] ?? "You"} · {r.successCount}✓{r.failureCount ? ` ${r.failureCount}✗` : ""}
                  </td>
                  <td className="py-2.5 pr-5 text-right">
                    <Button variant="ghost" size="sm" onClick={() => forget(r.id)} aria-label={`Forget mapping for ${r.label}`}>
                      <IconTrash size={14} /> Forget
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="text-sm text-gray-500">No mappings match.</p>}
    </div>
  );
}
