"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DOCUMENT_TYPE_LABELS, getFieldDef, type DocumentType } from "@ufa/shared";
import { Alert, Button, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { ConflictView } from "@/server/documents/types";

function sourceLabel(c: ConflictView["candidates"][number]) {
  if (c.source === "profile") return c.verified ? "Your profile (verified)" : "Your profile";
  return c.documentType ? DOCUMENT_TYPE_LABELS[c.documentType as DocumentType]?.en ?? c.documentType : "Document";
}

/** Spec §13: when sources disagree, the user decides — never the system. */
export function ConflictResolver({ conflict }: { conflict: ConflictView }) {
  const router = useRouter();
  const [choice, setChoice] = useState<number | "custom" | null>(null);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = getFieldDef(conflict.fieldKey)?.label.en ?? conflict.fieldKey;
  // Same value from several sources = one option listing all its sources. `index` is sent to the server.
  const options: { index: number; value: string; sources: string[] }[] = [];
  conflict.candidates.forEach((c, index) => {
    const existing = options.find((o) => o.value.trim().toLowerCase() === c.value.trim().toLowerCase());
    if (existing) existing.sources.push(sourceLabel(c));
    else options.push({ index, value: c.value, sources: [sourceLabel(c)] });
  });
  const distinct = options.length;

  async function resolve() {
    if (choice === null) return setError("Choose the correct value");
    setBusy(true);
    setError(null);
    const res = await api(`/api/conflicts/${conflict.id}/resolve`, {
      body: choice === "custom" ? { customValue: custom } : { chosenIndex: choice },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-950">
        {distinct > 1 ? `Your sources have ${distinct} different values for ${label}.` : `Please confirm ${label}.`} Which one is correct?
      </p>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">{label}</legend>
        {options.map((o) => (
          <label key={o.index} className="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">
            <input
              type="radio"
              name={`conflict-${conflict.id}`}
              checked={choice === o.index}
              onChange={() => setChoice(o.index)}
              aria-label={`${o.value} (from ${o.sources.join(", ")})`}
            />
            <span className="font-medium text-gray-900">{o.value}</span>
            <span className="text-xs text-gray-500">from {o.sources.join(", ")}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">
          <input type="radio" name={`conflict-${conflict.id}`} checked={choice === "custom"} onChange={() => setChoice("custom")} aria-label="None of these — type the correct value" />
          <span className="text-gray-700">None of these:</span>
          <Input value={custom} onChange={(e) => { setCustom(e.target.value); setChoice("custom"); }} className="max-w-xs" placeholder="Type the correct value" aria-label="Correct value" />
        </label>
      </fieldset>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <div className="mt-3">
        <Button size="sm" onClick={resolve} disabled={busy}>
          {busy ? "Saving…" : "Save correct value"}
        </Button>
      </div>
    </div>
  );
}
