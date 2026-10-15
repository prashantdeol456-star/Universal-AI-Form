import { acceptsFile, type ActionDecision } from "@ufa/form-engine";
import type { UploadField } from "@ufa/form-engine/dom";
import { useEffect, useState } from "react";
import { fetchDocumentForAttach, listAttachableDocuments, type AttachableDocument } from "./api";
import { attachFileInTab } from "./page";
import { authorizeSite, decide } from "./siteAccess";

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

export function UploadsCard({ tabId, url, domain, fields, server }: { tabId: number; url: string | null; domain: string; fields: UploadField[]; server: string }) {
  const [docs, setDocs] = useState<AttachableDocument[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Attaching documents is its own site permission (separate from filling).
  const [access, setAccess] = useState<ActionDecision | null>(null);

  useEffect(() => {
    let live = true;
    decide("attach_file", url)
      .then((d) => live && setAccess(d))
      .catch((err: unknown) => live && setAccess({ allowed: false, fix: "invalid_url", reason: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [url]);

  async function allowAttach() {
    if (!url) return;
    const a = await authorizeSite(url, ["attach_file"]);
    if (!a.ok) return setError(a.error);
    setError(null);
    setAccess(await decide("attach_file", url));
  }

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
    if (!id || !access?.allowed) return;
    setBusy(f.id);
    try {
      const res = await attachDocument(tabId, domain, f.id, id);
      setResult((x) => ({ ...x, [f.id]: res.ok ? { ok: true, text: `${res.text} Check it on the page (some sites now read it and fill the next steps).` } : res }));
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
      {access && !access.allowed && (
        <div className="warn small">
          {access.reason}.{" "}
          {access.fix === "authorize_site" && (
            <button className="link small" onClick={() => void allowAttach()}>
              Allow attaching documents on this site
            </button>
          )}
        </div>
      )}
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
                <button className="primary" disabled={!value || busy === f.id || !access?.allowed} onClick={() => void attach(f)}>
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

/** A document the assistant may offer for an empty upload field that clearly asks for it (CV, photo…). The user still decides per file. */
export interface AttachSuggestion {
  field: UploadField;
  doc: AttachableDocument | null;
  /** "CV", "photo", "signature"… */
  what: string;
}

export async function attachSuggestions(fields: UploadField[]): Promise<AttachSuggestion[]> {
  const wanted = fields.filter((f) => f.fileCount === 0 && f.suggested);
  if (!wanted.length) return [];
  const docs = await listAttachableDocuments();
  return wanted.map((f) => ({
    field: f,
    doc: docs.find((d) => d.documentType === f.suggested && acceptsFile(f.accept, d.fileName, d.mimeType)) ?? null,
    what: f.suggested === "resume" ? "CV" : f.suggested!.replace(/_/g, " "),
  }));
}

/** Attaches one document the user chose to one upload field (the server checks the attach_file grant for the site). */
export async function attachDocument(tabId: number, domain: string, fieldId: string, documentId: string): Promise<{ ok: boolean; text: string }> {
  const file = await fetchDocumentForAttach(documentId, domain);
  const r = await attachFileInTab(tabId, { fieldId, ...file });
  if (!r.ok) return { ok: false, text: r.error };
  return r.outcome.ok ? { ok: true, text: `Attached “${r.outcome.fileName}”.` } : { ok: false, text: REASON[r.outcome.reason]! };
}
