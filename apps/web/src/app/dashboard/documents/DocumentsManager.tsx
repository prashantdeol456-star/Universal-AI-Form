"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, type DocumentType } from "@ufa/shared";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import type { DocumentSummary } from "@/server/documents/types";

export function formatBytes(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function StatusBadge({ doc }: { doc: Pick<DocumentSummary, "status" | "pendingCount" | "extractable" | "scanStatus"> }) {
  if (doc.scanStatus === "INFECTED") return <Badge tone="red">Blocked: malware</Badge>;
  switch (doc.status) {
    case "UPLOADED":
      return <Badge tone="blue">Queued</Badge>;
    case "PROCESSING":
      return <Badge tone="blue">Reading…</Badge>;
    case "FAILED":
      return <Badge tone="red">Failed</Badge>;
    default:
      if (!doc.extractable) return <Badge tone="green">Stored</Badge>;
      return doc.pendingCount > 0 ? <Badge tone="amber">{doc.pendingCount} to review</Badge> : <Badge tone="green">Reviewed</Badge>;
  }
}

export function DocumentsManager({ documents, maxUploadMb }: { documents: DocumentSummary[]; maxUploadMb: number }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const processing = documents.some((d) => d.status === "UPLOADED" || d.status === "PROCESSING");

  // While anything is queued or being read, refresh the list every few seconds.
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [processing, router]);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return setMsg({ tone: "red", text: "Choose a file" });
    if (file.size > maxUploadMb * 1024 * 1024) return setMsg({ tone: "red", text: `File is larger than ${maxUploadMb} MB` });
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/documents", { method: "POST", body: form, credentials: "same-origin" }).catch(() => null);
    setBusy(false);
    const payload = await res?.json().catch(() => null);
    if (!res?.ok) return setMsg({ tone: "red", text: payload?.error?.message ?? "Upload failed" });
    formRef.current?.reset();
    setMsg({ tone: "green", text: "Uploaded. Reading the document now — values will appear for your review." });
    router.refresh();
  }

  async function remove(d: DocumentSummary) {
    if (!window.confirm(`Delete "${d.originalFilename}"? Values you already confirmed stay in your profile.`)) return;
    const res = await fetch(`/api/documents/${d.id}`, { method: "DELETE" });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return setMsg({ tone: "red", text: payload?.error?.message ?? "Delete failed" });
    if (payload?.fileRetained) setMsg({ tone: "green", text: "Removed from your list. The file is kept because a saved application uses it." });
    router.refresh();
  }

  return (
    <>
      <Card title="Upload a document">
        <form ref={formRef} onSubmit={onUpload} className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
          <div>
            <Label htmlFor="documentType">Document type</Label>
            <Select id="documentType" name="documentType" defaultValue="aadhaar" required>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t].en}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="title" hint="(optional)">Title</Label>
            <Input id="title" name="title" maxLength={120} placeholder="e.g. Aadhaar front" />
          </div>
          <div>
            <Label htmlFor="file" hint={`(PDF, JPG, PNG, WEBP · max ${maxUploadMb} MB)`}>File</Label>
            <input
              id="file"
              name="file"
              type="file"
              required
              accept="application/pdf,image/jpeg,image/png,image/webp"
              className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </form>
        <p className="mt-3 text-xs text-gray-500">
          Tip: for scanned papers, upload a clear photo or image scan. PDFs that are only scans (no selectable text) cannot be
          read yet. Photos and signatures are stored for form uploads; no data is read from them.
        </p>
        {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      </Card>

      <Card title={`Your documents (${documents.length})`}>
        {documents.length === 0 ? (
          <p className="text-sm text-gray-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/documents/${d.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      {d.title ?? DOCUMENT_TYPE_LABELS[d.documentType as DocumentType]?.en ?? d.documentType}
                    </Link>
                    <StatusBadge doc={d} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-gray-500">
                    {DOCUMENT_TYPE_LABELS[d.documentType as DocumentType]?.hi} · {d.originalFilename} · {formatBytes(d.sizeBytes)}
                    {d.widthPx ? ` · ${d.widthPx}×${d.heightPx}px` : ""} · {new Date(d.createdAt).toLocaleDateString("en-IN")}
                  </div>
                  {d.status === "FAILED" && d.processingError && <div className="mt-1 text-xs text-red-700">{d.processingError}</div>}
                </div>
                <div className="flex gap-1">
                  <Link href={`/dashboard/documents/${d.id}`} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50">
                    {d.pendingCount > 0 ? "Review" : "Open"}
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => remove(d)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
