import { acceptsFile } from "@ufa/form-engine";
import type { UploadField } from "@ufa/form-engine/dom";
import { useEffect, useState } from "react";
import { fetchDocumentForAttach, listAttachableDocuments, type AttachableDocument } from "./api";
import { attachFileInTab } from "./page";

/**
 * Upload fields on the page ("Upload your resume", photo, signature): the user
 * picks one of their own documents and clicks Attach. Nothing is attached
 * automatically and the form is never submitted.
 */
const REASON: Record<string, string> = {
  not_found: "The upload box is no longer on the page. Analyze again.",
  not_accepted: "The page does not accept this file type. Pick another document.",
  rejected_by_page: "The page did not accept the file. Use its own “Select file” button.",
  disabled: "The upload box is disabled right now.",
};

export function UploadsCard({ tabId, domain, fields, server }: { tabId: number; domain: string; fields: UploadField[]; server: string }) {
  const [docs, setDocs] = useState<AttachableDocument[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAttachableDocuments()
      .then(setDocs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const compatible = (f: UploadField) => (docs ?? []).filter((d) => acceptsFile(f.accept, d.fileName, d.mimeType));
  const defaultFor = (f: UploadField) => {
    const list = compatible(f);
    return (list.find((d) => d.documentType === f.suggested) ?? (list.length === 1 ? list[0] : undefined))?.id ?? "";
  };

  async function attach(f: UploadField) {
    const id = choice[f.id] ?? defaultFor(f);
    if (!id) return;
    setBusy(f.id);
    try {
      const file = await fetchDocumentForAttach(id, domain);
      const r = await attachFileInTab(tabId, { fieldId: f.id, ...file });
      const text = !r.ok ? r.error : r.outcome.ok ? `Attached “${r.outcome.fileName}”. Check it on the page (some sites now read it and fill the next steps).` : REASON[r.outcome.reason]!;
      setResult((x) => ({ ...x, [f.id]: { ok: r.ok && r.outcome.ok, text } }));
    } catch (err) {
      setResult((x) => ({ ...x, [f.id]: { ok: false, text: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="eyebrow">Upload fields on this page</div>
      {error && <div className="alert">{error}</div>}
      {docs && docs.length === 0 && (
        <p className="small" style={{ margin: 0 }}>
          You have no documents yet.{" "}
          <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/documents` })}>
            Upload your CV
          </button>{" "}
          (type “Resume / CV”), then come back and attach it here.
        </p>
      )}
      {fields.map((f) => {
        const list = compatible(f);
        const value = choice[f.id] ?? defaultFor(f);
        return (
          <div key={f.id} className="upload-row">
            <div className="small ellipsis" title={f.label}>
              <b>{f.label}</b>
              {f.fileCount > 0 && <span className="muted"> · already has a file</span>}
            </div>
            {docs && docs.length > 0 && (
              <div className="row-actions">
                <select value={value} onChange={(e) => setChoice((c) => ({ ...c, [f.id]: e.target.value }))} aria-label={`Document for ${f.label}`}>
                  <option value="">{list.length ? "Choose a document…" : "No document of an accepted type"}</option>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.typeLabel} · {d.fileName}
                    </option>
                  ))}
                </select>
                <button className="primary" disabled={!value || busy === f.id} onClick={() => void attach(f)}>
                  {busy === f.id ? "Attaching…" : "Attach"}
                </button>
              </div>
            )}
            {result[f.id] && <div className={result[f.id]!.ok ? "info small" : "alert"}>{result[f.id]!.text}</div>}
          </div>
        );
      })}
      <p className="muted small" style={{ margin: 0 }}>
        Only the file you pick is attached. The form is never submitted for you.
      </p>
    </div>
  );
}

/**
 * Agent step: attach the matching document to each empty upload field that clearly
 * asks for it (resume, photo, signature…). Returns one log line per field.
 */
export async function autoAttach(tabId: number, domain: string, fields: UploadField[]): Promise<Array<{ ok: boolean; text: string }>> {
  const wanted = fields.filter((f) => f.fileCount === 0 && f.suggested);
  if (!wanted.length) return [];
  const docs = await listAttachableDocuments();
  const out: Array<{ ok: boolean; text: string }> = [];
  for (const f of wanted) {
    const doc = docs.find((d) => d.documentType === f.suggested && acceptsFile(f.accept, d.fileName, d.mimeType));
    const what = f.suggested === "resume" ? "CV" : f.suggested!.replace(/_/g, " ");
    if (!doc) {
      out.push({ ok: false, text: `No ${what} of an accepted type in your documents — upload it in Dashboard → Documents, or choose a file on the page.` });
      continue;
    }
    const file = await fetchDocumentForAttach(doc.id, domain);
    const r = await attachFileInTab(tabId, { fieldId: f.id, ...file });
    if (!r.ok) out.push({ ok: false, text: `Could not attach your ${what}: ${r.error}` });
    else if (r.outcome.ok) out.push({ ok: true, text: `Attached your ${what} “${file.name}”.` });
    else out.push({ ok: false, text: `Could not attach your ${what}: ${REASON[r.outcome.reason]}` });
  }
  return out;
}
