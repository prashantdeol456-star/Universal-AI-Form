"use client";

import { useState } from "react";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api-client";

/** Lets the user turn the cloud AI fallback (Gemini) on or off. */
export function CloudAiToggle({ initial, available }: { initial: boolean; available: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const res = await api<{ cloudAiEnabled: boolean }>("/api/account/preferences", { method: "PATCH", body: { cloudAiEnabled: next } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setEnabled(res.data.cloudAiEnabled);
  }

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span>
          <span className="font-medium text-gray-900">Use Google Gemini for fields the assistant cannot recognise</span>
          <span className="block text-gray-500">
            Only the field&apos;s label, section, type and option names are sent (for example “Name of local guardian”). Your values,
            documents and the page itself are never sent. Gemini&apos;s answers are always shown to you for confirmation.
          </span>
        </span>
      </label>
      {!available && <Alert tone="amber">Gemini is not configured on this server, so this setting has no effect right now.</Alert>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
