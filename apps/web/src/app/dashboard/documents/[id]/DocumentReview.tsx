"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DOCUMENT_TYPE_LABELS, getFieldDef, type DocumentType } from "@ufa/shared";
import { Alert, Badge, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { ConflictView, DocumentDetail, ExtractionView } from "@/server/documents/types";
import { ConflictResolver } from "../ConflictResolver";
import { formatBytes, StatusBadge } from "../DocumentsManager";

const METHOD_LABEL: Record<string, string> = {
  rules: "Pattern match",
  local_ai: "Local AI",
  "rules+local_ai": "Pattern match + Local AI agree",
};

function confidenceTone(c: number | null) {
  if (c === null) return "gray" as const;
  return c >= 0.9 ? ("green" as const) : c >= 0.7 ? ("blue" as const) : ("amber" as const);
}

export function DocumentReview({ doc, conflicts }: { doc: DocumentDetail; conflicts: ConflictView[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const processing = doc.status === "UPLOADED" || doc.status === "PROCESSING";
  const pending = doc.extractions.filter((e) => e.status === "PENDING");
  const done = doc.extractions.filter((e) => e.status !== "PENDING");
  const typeLabel = DOCUMENT_TYPE_LABELS[doc.documentType as DocumentType];

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [processing, router]);

  async function reprocess() {
    const res = await api(`/api/documents/${doc.id}/reprocess`, { method: "POST" });
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    setMsg({ tone: "green", text: "Reading the document again…" });
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/documents" className="text-sm text-brand-600 hover:underline">
            ← Documents
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {doc.title ?? typeLabel?.en ?? doc.documentType} <StatusBadge doc={doc} />
          </h1>
          <p className="text-sm text-gray-500">
            {typeLabel?.hi} · {doc.originalFilename} · {formatBytes(doc.sizeBytes)}
            {doc.widthPx ? ` · ${doc.widthPx}×${doc.heightPx}px` : ""}
          </p>
        </div>
        {doc.extractable && (doc.status === "FAILED" || doc.status === "EXTRACTED") && (
          <Button variant="secondary" size="sm" onClick={reprocess}>
            Read again
          </Button>
        )}
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {doc.status === "FAILED" && <Alert>{doc.processingError ?? "Processing failed."}</Alert>}
      {processing && <Alert tone="blue">Reading your document… this page updates automatically.</Alert>}
      {doc.scanStatus === "SKIPPED" && !processing && (
        <p className="text-xs text-gray-500">Antivirus scanning is not enabled on this server; the file passed type and safety checks.</p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Original">
          {doc.mimeType.startsWith("image/") ? (
            <img src={doc.fileUrl} alt={`${typeLabel?.en ?? "Document"} preview`} className="w-full rounded-lg border border-gray-200" />
          ) : (
            <p className="text-sm text-gray-600">PDF document.</p>
          )}
          <div className="mt-3 flex gap-3 text-sm">
            <a href={doc.fileUrl} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">
              Open
            </a>
            <a href={`${doc.fileUrl}&download=1`} className="text-brand-600 hover:underline">
              Download
            </a>
          </div>
          {doc.textEngine && (
            <p className="mt-3 text-xs text-gray-500">
              Read with {doc.textEngine === "tesseract" ? "OCR (Tesseract)" : "the PDF's text layer"}
              {doc.textConfidence !== null ? ` · OCR quality ${Math.round(doc.textConfidence * 100)}%` : ""}
              {doc.localAiUsed ? " · checked by local AI" : ""}
            </p>
          )}
        </Card>

        <div className="space-y-4">
          {conflicts.map((c) => (
            <ConflictResolver key={c.id} conflict={c} />
          ))}

          {!doc.extractable ? (
            <Card>
              <p className="text-sm text-gray-600">
                {typeLabel?.en ?? "This document"} is stored for uploading into forms. No profile data is read from it.
              </p>
            </Card>
          ) : (
            <Card title={`Found in this document${pending.length ? ` — ${pending.length} to review` : ""}`}>
              {doc.status === "EXTRACTED" && doc.extractions.length === 0 && (
                <p className="text-sm text-gray-600">
                  No profile values could be read. Try a sharper, well-lit, straight photo, then use “Read again”, or add the values on
                  your profile page.
                </p>
              )}
              {pending.length > 0 && (
                <p className="mb-2 text-xs text-gray-500">
                  Check each value against the original. Only confirmed values are saved to your profile.
                </p>
              )}
              <ul className="divide-y divide-gray-100">
                {pending.map((e) => (
                  <ExtractionRow key={e.id} e={e} onMessage={setMsg} />
                ))}
                {done.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="text-gray-700">{getFieldDef(e.fieldKey)?.label.en ?? e.fieldKey}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-gray-900">{e.sensitive ? "••••" + e.value.slice(-4) : e.value}</span>
                      <Badge tone="green">{e.status === "EDITED" ? "Saved (edited)" : "Saved"}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function ExtractionRow({ e, onMessage }: { e: ExtractionView; onMessage: (m: { tone: "red" | "green"; text: string }) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(e.value);
  const [busy, setBusy] = useState(false);
  const def = getFieldDef(e.fieldKey);
  const sameAsProfile = e.profileValue !== null && !e.sensitive && e.profileValue.trim().toLowerCase() === e.value.trim().toLowerCase();

  async function act(action: "confirm" | "reject") {
    setBusy(true);
    const res = await api<{ status: string }>(`/api/documents/extractions/${e.id}`, {
      body: action === "confirm" ? { action, value: editing ? value : undefined } : { action },
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409 && res.error.code === "http_error") {
        // A value conflict (not an HttpError): the resolver appears at the top after refresh.
        onMessage({ tone: "red", text: "This value differs from what is already saved. Choose the correct one above." });
      } else {
        onMessage({ tone: "red", text: res.error.message });
      }
    }
    router.refresh();
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-44">
          <div className="text-sm font-medium text-gray-900">{def?.label.en ?? e.fieldKey}</div>
          <div className="text-xs text-gray-400">{def?.label.hi}</div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
          {editing ? (
            <Input value={value} onChange={(ev) => setValue(ev.target.value)} className="max-w-xs" aria-label={def?.label.en} autoFocus />
          ) : (
            <span className="text-sm font-medium text-gray-900">{e.value}</span>
          )}
          <span className="flex flex-wrap justify-end gap-1">
            <Badge tone={confidenceTone(e.confidence)}>{e.confidence === null ? "—" : `${Math.round(e.confidence * 100)}%`}</Badge>
            <Badge>{METHOD_LABEL[e.method] ?? e.method}</Badge>
            {e.conflictId && <Badge tone="amber">Conflict</Badge>}
          </span>
          {e.profileValue !== null && (
            <span className="text-xs text-gray-500">
              Profile has: {e.profileValue} {e.profileVerified ? "(verified)" : ""} {sameAsProfile && "— same"}
            </span>
          )}
        </div>
      </div>
      {!e.conflictId && (
        <div className="mt-2 flex justify-end gap-1">
          <Button size="sm" disabled={busy} onClick={() => act("confirm")}>
            {editing ? "Save edited" : sameAsProfile ? "Confirm (same)" : "Confirm"}
          </Button>
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("reject")}>
            Wrong — ignore
          </Button>
        </div>
      )}
    </li>
  );
}
