"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { DocumentDetail } from "@/server/documents/types";

const ENGINE: Record<string, string> = { "pdf-text": "PDF text", tesseract: "OCR (image)", docx: "Word document", "plain-text": "Text file" };

/** Search status of one document and the per-document cloud AI switch (knowledge base). */
export function KnowledgeCard({ doc }: { doc: DocumentDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(allowed: boolean) {
    if (allowed && !window.confirm("Allow cloud AI (Google Gemini) to read relevant excerpts of this document when you ask a question? Only short excerpts are sent, never the whole file. You can switch this off any time.")) return;
    setBusy(true);
    const res = await api(`/api/documents/${doc.id}`, { method: "PATCH", body: { cloudAiAllowed: allowed } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setError(null);
    router.refresh();
  }

  return (
    <Card title="Search and AI">
      <div className="space-y-2 text-sm text-gray-700">
        {doc.lifecycle === "ready" && doc.chunkCount > 0 ? (
          <p>
            <Badge tone="green">Searchable</Badge> {doc.chunkCount} part{doc.chunkCount === 1 ? "" : "s"}
            {doc.pageCount ? ` from ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : ""}
            {doc.textEngine ? ` · read as ${ENGINE[doc.textEngine] ?? doc.textEngine}` : ""}.{" "}
            <Link href="/dashboard/knowledge" className="text-brand-700 hover:underline">
              Search your documents
            </Link>
          </p>
        ) : doc.lifecycle === "ready" ? (
          <p className="text-gray-500">{doc.processingError ? `Not searchable: ${doc.processingError}` : "This document is stored for form uploads only and is not searchable."}</p>
        ) : doc.lifecycle === "failed" ? (
          <p className="text-red-700">Not searchable: {doc.processingError ?? "the document could not be read."}</p>
        ) : (
          <p className="text-gray-500">Reading the document…</p>
        )}
        {doc.textTruncated && <p className="text-amber-700">Very long document: only the first part was read.</p>}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={doc.cloudAiAllowed} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          <span>
            Allow cloud AI to read relevant excerpts of this document
            <span className="block text-xs text-gray-500">
              Off by default. When off, answers use this document only with a self-hosted model, or show the excerpts without AI.
            </span>
          </span>
        </label>
        {error && <Alert>{error}</Alert>}
      </div>
    </Card>
  );
}
