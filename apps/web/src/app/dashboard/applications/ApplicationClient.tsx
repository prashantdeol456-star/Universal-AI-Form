"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconBookmark, IconCheck, IconEye, IconLink, IconLock, IconTrash } from "@/components/icons";
import { Alert, Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api-client";

/** "I submitted it" with an optional portal application number. */
export function MarkSubmitted({ id, compact = false }: { id: string; compact?: boolean }) {
  const router = useRouter();
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await api(`/api/applications/${id}`, { method: "PATCH", body: { status: "SUBMITTED", applicationNumber: number.trim() || null } });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    router.refresh();
  }

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "space-y-2"}>
      <Input
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        maxLength={100}
        placeholder="Application no. (optional)"
        aria-label="Application number"
        className={compact ? "max-w-52" : undefined}
      />
      <Button onClick={submit} disabled={busy} size={compact ? "sm" : "md"}>
        <IconCheck size={15} /> I submitted it
      </Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function CancelApplication({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={async () => {
        if (!confirm("Mark this application as not submitted (cancelled)? The record is kept.")) return;
        setBusy(true);
        await api(`/api/applications/${id}`, { method: "PATCH", body: { status: "CANCELLED" } });
        setBusy(false);
        router.refresh();
      }}
    >
      Not submitting
    </Button>
  );
}

export function EditApplicationNumber({ id, initial }: { id: string; initial: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!editing) {
    return (
      <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setEditing(true)}>
        {initial ? "Edit" : "Add number"}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await api(`/api/applications/${id}`, { method: "PATCH", body: { applicationNumber: value.trim() || null } });
        if (!r.ok) return setError(r.error.message);
        setEditing(false);
        router.refresh();
      }}
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} className="max-w-52" aria-label="Application number" autoFocus />
      <Button size="sm" type="submit">
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

export interface FieldRow {
  id: string;
  label: string;
  value: string | null;
  masked: boolean;
  profileFieldLabel: string | null;
  source: string | null;
  confidence: number | null;
  aiProvider: string | null;
  verified: boolean;
}

/** The confirmed snapshot; masked values can be revealed by the owner (audited). */
export function SnapshotTable({ applicationId, fields }: { applicationId: string; fields: FieldRow[] }) {
  const [revealed, setRevealed] = useState<Map<string, string | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anyMasked = fields.some((f) => f.masked);

  async function reveal() {
    setBusy(true);
    setError(null);
    const r = await api<{ values: Array<{ id: string; value: string | null }> }>(`/api/applications/${applicationId}/reveal`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setRevealed(new Map(r.data.values.map((v) => [v.id, v.value])));
  }

  return (
    <div>
      {anyMasked && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <span className="flex items-center gap-1.5">
            <IconLock size={14} /> Sensitive values are masked. Showing them is recorded in your access log.
          </span>
          {revealed ? (
            <Button size="sm" variant="secondary" onClick={() => setRevealed(null)}>
              Hide values
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={reveal} disabled={busy}>
              <IconEye size={14} /> Show values
            </Button>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr className="border-b border-gray-100">
              <th className="py-2 pr-4 font-medium">Field on the website</th>
              <th className="py-2 pr-4 font-medium">Value filled</th>
              <th className="py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {fields.map((f) => {
              const value = revealed?.has(f.id) ? revealed.get(f.id) : f.value;
              return (
                <tr key={f.id} className="align-top">
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-gray-900">{f.label}</div>
                    {f.profileFieldLabel && <div className="text-xs text-gray-500">from “{f.profileFieldLabel}”</div>}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[13px] break-all text-gray-800">{value ?? "—"}</td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {f.source === "manual" ? <Badge tone="amber">Typed by you</Badge> : <Badge tone="blue">Profile</Badge>}
                      {f.verified && <Badge tone="green">Verified</Badge>}
                      {f.aiProvider && <Badge>{f.aiProvider === "gemini" ? "Gemini suggested" : "Local AI suggested"}</Badge>}
                    </div>
                    {f.confidence !== null && <div className="mt-1 text-xs text-gray-400">match {Math.round(f.confidence * 100)}%</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Which documents were used for this application. */
export function DocumentLinks({
  applicationId,
  linked,
  available,
}: {
  applicationId: string;
  linked: Array<{ id: string; title: string; typeLabel: string; label: string | null }>;
  available: Array<{ id: string; title: string; typeLabel: string }>;
}) {
  const router = useRouter();
  const [docId, setDocId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!docId) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/applications/${applicationId}/documents`, { body: { links: [{ documentId: docId, label: label.trim() || null }] } });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setDocId("");
    setLabel("");
    router.refresh();
  }

  async function remove(documentId: string) {
    const r = await api(`/api/applications/${applicationId}/documents/${documentId}`, { method: "DELETE" });
    if (!r.ok) return setError(r.error.message);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {linked.length === 0 ? (
        <p className="text-sm text-gray-500">No documents linked. Link the files you uploaded on the website (photo, signature, certificates) to keep a complete record.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {linked.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <a href={`/dashboard/documents/${d.id}`} className="min-w-0">
                <span className="block truncate text-sm font-medium text-gray-900 hover:text-brand-700">{d.title}</span>
                <span className="block truncate text-xs text-gray-500">
                  {d.typeLabel}
                  {d.label ? ` · used for “${d.label}”` : ""}
                </span>
              </a>
              <Button variant="ghost" size="sm" onClick={() => remove(d.id)} aria-label={`Unlink ${d.title}`}>
                <IconTrash size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Select value={docId} onChange={(e) => setDocId(e.target.value)} aria-label="Document">
            <option value="">Choose a document…</option>
            {available.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} ({d.typeLabel})
              </option>
            ))}
          </Select>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="Used for (e.g. Photograph)" aria-label="Used for" />
          <Button type="submit" variant="secondary" disabled={!docId || busy}>
            <IconLink size={15} /> Link
          </Button>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

/** Bookmark the form's page in Saved Forms. */
export function SaveFormButton({ name, url, saved }: { name: string; url: string; saved: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (saved) {
    return (
      <Badge tone="green">
        <IconBookmark size={12} className="mr-1" /> Saved form
      </Badge>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api("/api/saved-forms", { body: { name, url } });
        setBusy(false);
        router.refresh();
      }}
    >
      <IconBookmark size={14} /> Save form
    </Button>
  );
}
