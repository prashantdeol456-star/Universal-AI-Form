import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { detectFileType, isExtractable, pdfHasActiveContent, sanitizeFilename } from "@ufa/document-engine";
import { imageInfo } from "@ufa/document-engine/ocr";
import { DOCUMENT_TYPES, maskValue, type DocumentType } from "@ufa/shared";
import { signResource, verifySignedResource } from "@ufa/security";
import { audit } from "../audit";
import { asUser, type Actor } from "../db";
import { env } from "../env";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http";
import { updateFieldTx } from "../profile/service";
import { storage } from "../storage";
import { isSensitiveKey, normalizeValue, readStored, storeValue, upsertConflict, type StoredCandidate } from "./conflicts";
import type { ConfirmResult, ConflictView, DocumentDetail, DocumentSummary, ExtractionView } from "./types";
import { kickDocumentWorker } from "./worker";

interface DocRow {
  id: string;
  user_id: string;
  document_type: DocumentType;
  title: string | null;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: string;
  width_px: number | null;
  height_px: number | null;
  status: DocumentSummary["status"];
  scan_status: DocumentSummary["scanStatus"];
  processing_error: string | null;
  text_engine: string | null;
  text_confidence: string | null;
  local_ai_used: boolean;
  created_at: Date;
  processed_at: Date | null;
  pending: number;
  confirmed: number;
}

const DOC_COLUMNS = `d.id, d.user_id, d.document_type, d.title, d.storage_key, d.original_filename, d.mime_type, d.size_bytes,
  d.width_px, d.height_px, d.status, d.scan_status, d.processing_error, d.text_engine, d.text_confidence, d.local_ai_used,
  d.created_at, d.processed_at,
  (select count(*)::int from document_extractions e where e.document_id = d.id and e.status = 'PENDING') as pending,
  (select count(*)::int from document_extractions e where e.document_id = d.id and e.status in ('CONFIRMED','EDITED')) as confirmed`;

function toSummary(r: DocRow): DocumentSummary {
  return {
    id: r.id,
    documentType: r.document_type,
    title: r.title,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    widthPx: r.width_px,
    heightPx: r.height_px,
    status: r.status,
    scanStatus: r.scan_status,
    processingError: r.processing_error,
    extractable: isExtractable(r.document_type),
    pendingCount: r.pending,
    confirmedCount: r.confirmed,
    createdAt: r.created_at.toISOString(),
    processedAt: r.processed_at?.toISOString() ?? null,
  };
}

// --- Upload ------------------------------------------------------------------------

export async function uploadDocument(
  actor: Actor,
  input: { file: File; documentType: string; title?: string | null },
  ip?: string,
): Promise<{ id: string }> {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) throw badRequest("Unknown document type");
  const documentType = input.documentType as DocumentType;
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  if (input.file.size === 0) throw badRequest("The file is empty");
  if (input.file.size > maxBytes) throw new HttpError(413, "too_large", `File is larger than ${env().MAX_UPLOAD_MB} MB`);

  const buf = Buffer.from(await input.file.arrayBuffer());
  const type = detectFileType(buf);
  if (!type) throw new HttpError(415, "unsupported_type", "Only PDF, JPG, PNG and WEBP files are accepted");
  if (type.kind === "pdf" && pdfHasActiveContent(buf)) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "security.upload_rejected", subjectUserId: actor.id, ip, metadata: { reason: "pdf_active_content" } });
    throw new HttpError(422, "unsafe_file", "This PDF contains scripts or embedded files and was rejected for safety");
  }
  let dims: { width: number; height: number } | null = null;
  if (type.kind === "image") {
    dims = await imageInfo(buf);
    if (!dims) throw new HttpError(422, "corrupt_file", "The image could not be read. It may be damaged.");
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const id = randomUUID();
  const storageKey = `users/${actor.id}/${id}.${type.ext}`;
  const title = input.title?.trim().slice(0, 120) || null;

  await asUser(actor, async (tx) => {
    const [dup] = await tx<{ id: string }[]>`select id from documents where user_id = ${actor.id} and sha256 = ${sha256} and deleted_at is null`;
    if (dup) throw conflict("You have already uploaded this exact file", { existingId: dup.id });
  });

  await storage().put(storageKey, buf);
  try {
    await asUser(actor, async (tx) => {
      await tx`
        insert into documents (id, user_id, document_type, title, storage_key, original_filename, mime_type, size_bytes, sha256, width_px, height_px)
        values (${id}, ${actor.id}, ${documentType}, ${title}, ${storageKey}, ${sanitizeFilename(input.file.name, type.ext)}, ${type.mime},
                ${buf.length}, ${sha256}, ${dims?.width ?? null}, ${dims?.height ?? null})`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "document.uploaded", targetType: "document", targetId: id, subjectUserId: actor.id, ip, metadata: { documentType, mime: type.mime, size: buf.length } }, tx);
    });
  } catch (err) {
    await storage().delete(storageKey).catch(() => {});
    throw err;
  }
  kickDocumentWorker();
  return { id };
}

// --- Read --------------------------------------------------------------------------

export async function listDocuments(actor: Actor): Promise<DocumentSummary[]> {
  const rows = await asUser(actor, (tx) =>
    tx.unsafe<DocRow[]>(`select ${DOC_COLUMNS} from documents d where d.user_id = $1 and d.deleted_at is null order by d.created_at desc`, [actor.id]),
  );
  return rows.map(toSummary);
}

export function signedFileUrl(documentId: string, ttlSeconds = 300): string {
  return `/api/documents/${documentId}/file?t=${encodeURIComponent(signResource(env().AUTH_SECRET, `doc:${documentId}`, ttlSeconds))}`;
}

export async function getDocument(actor: Actor, id: string): Promise<DocumentDetail> {
  return asUser(actor, async (tx) => {
    const [doc] = await tx.unsafe<DocRow[]>(`select ${DOC_COLUMNS} from documents d where d.id = $1 and d.user_id = $2 and d.deleted_at is null`, [id, actor.id]);
    if (!doc) throw notFound("Document not found");
    const ex = await tx<{ id: string; field_key: string; extracted_value: string; is_encrypted: boolean; confidence: string | null; method: string; status: ExtractionView["status"]; conflict_id: string | null }[]>`
      select id, field_key, extracted_value, is_encrypted, confidence, method, status, conflict_id
        from document_extractions where document_id = ${id} and status <> 'REJECTED'
       order by field_key, confidence desc nulls last`;
    const keys = [...new Set(ex.map((e) => e.field_key))];
    const profile = keys.length
      ? await tx<{ field_key: string; value: string; is_encrypted: boolean; verified: boolean }[]>`
          select field_key, value, is_encrypted, verified from profile_fields
           where user_id = ${actor.id} and deleted_at is null and field_key in ${tx(keys)}`
      : [];
    const openConflicts = keys.length
      ? await tx<{ id: string; field_key: string }[]>`
          select id, field_key from document_conflicts where user_id = ${actor.id} and status = 'OPEN' and field_key in ${tx(keys)}`
      : [];
    const profileByKey = new Map(profile.map((p) => [p.field_key, p]));
    const conflictByKey = new Map(openConflicts.map((c) => [c.field_key, c.id]));

    return {
      ...toSummary(doc),
      textEngine: doc.text_engine,
      textConfidence: doc.text_confidence === null ? null : Number(doc.text_confidence),
      localAiUsed: doc.local_ai_used,
      fileUrl: signedFileUrl(id),
      extractions: ex.map((e) => {
        const p = profileByKey.get(e.field_key);
        const sensitive = isSensitiveKey(e.field_key);
        const pv = p ? readStored(p) : null;
        return {
          id: e.id,
          fieldKey: e.field_key,
          // Shown in full to the owner for verification (response is no-store).
          value: readStored({ value: e.extracted_value, is_encrypted: e.is_encrypted }),
          confidence: e.confidence === null ? null : Number(e.confidence),
          method: e.method,
          status: e.status,
          sensitive,
          conflictId: e.status === "PENDING" ? conflictByKey.get(e.field_key) ?? null : null,
          profileValue: pv === null ? null : sensitive ? maskValue(pv) : pv,
          profileVerified: p?.verified ?? false,
        };
      }),
    };
  });
}

/** Streams the original file after verifying the signed token AND the caller's row-level access. */
export async function readDocumentFile(actor: Actor, id: string, token: string): Promise<{ data: Buffer; mime: string; filename: string }> {
  if (!verifySignedResource(env().AUTH_SECRET, `doc:${id}`, token)) throw forbidden("This file link has expired. Reload the page.");
  const row = await asUser(actor, async (tx) => {
    // RLS: the owner, or a café operator with an approved 'documents' permission.
    const [r] = await tx<{ storage_key: string; mime_type: string; original_filename: string; user_id: string }[]>`
      select storage_key, mime_type, original_filename, user_id from documents where id = ${id} and deleted_at is null`;
    if (r && r.user_id !== actor.id) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: "document.accessed_by_cafe", targetType: "document", targetId: id, subjectUserId: r.user_id }, tx);
    }
    return r;
  });
  if (!row) throw notFound("Document not found");
  return { data: await storage().get(row.storage_key), mime: row.mime_type, filename: row.original_filename };
}

// --- Delete / reprocess -----------------------------------------------------------

export async function deleteDocument(actor: Actor, id: string, ip?: string): Promise<{ fileRetained: boolean }> {
  const result = await asUser(actor, async (tx) => {
    const [doc] = await tx<{ storage_key: string }[]>`
      select storage_key from documents where id = ${id} and user_id = ${actor.id} and deleted_at is null for update`;
    if (!doc) throw notFound("Document not found");
    const [used] = await tx`select 1 from application_documents where document_id = ${id} limit 1`;
    await tx`update documents set deleted_at = now() where id = ${id}`;
    await tx`update document_extractions set status = 'REJECTED', reviewed_at = now(), reviewed_by = ${actor.id}
              where document_id = ${id} and status = 'PENDING'`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "document.deleted", targetType: "document", targetId: id, subjectUserId: actor.id, ip, metadata: { fileRetained: Boolean(used) } }, tx);
    return { storageKey: doc.storage_key, fileRetained: Boolean(used) };
  });
  // Files referenced by a submitted application snapshot are kept for that record.
  if (!result.fileRetained) await storage().delete(result.storageKey);
  return { fileRetained: result.fileRetained };
}

export async function reprocessDocument(actor: Actor, id: string, systemRequeue: (id: string) => Promise<boolean>): Promise<void> {
  await asUser(actor, async (tx) => {
    const [doc] = await tx`select 1 from documents where id = ${id} and user_id = ${actor.id} and deleted_at is null`;
    if (!doc) throw notFound("Document not found");
  });
  if (!(await systemRequeue(id))) throw conflict("This document is already being processed");
  kickDocumentWorker();
}

// --- Review: confirm / reject extracted values -------------------------------------

export async function confirmExtraction(actor: Actor, extractionId: string, editedValue: string | undefined, ip?: string): Promise<ConfirmResult> {
  return asUser(actor, async (tx) => {
    const [e] = await tx<{ id: string; document_id: string; document_type: string; field_key: string; extracted_value: string; is_encrypted: boolean; confidence: string | null; status: string }[]>`
      select e.id, e.document_id, d.document_type, e.field_key, e.extracted_value, e.is_encrypted, e.confidence, e.status
        from document_extractions e join documents d on d.id = e.document_id
       where e.id = ${extractionId} and e.user_id = ${actor.id} and d.deleted_at is null
       for update of e`;
    if (!e) throw notFound("Extracted value not found");
    if (e.status !== "PENDING") throw conflict("This value was already reviewed");

    const extracted = readStored({ value: e.extracted_value, is_encrypted: e.is_encrypted });
    const value = editedValue?.trim() || extracted;
    const edited = Boolean(editedValue?.trim()) && normalizeValue(editedValue!) !== normalizeValue(extracted);

    // An open conflict for this field must be resolved explicitly first.
    const [open] = await tx<{ id: string }[]>`
      select id from document_conflicts where user_id = ${actor.id} and field_key = ${e.field_key} and status = 'OPEN'`;
    if (open) {
      await upsertConflict(tx, actor.id, e.field_key, [
        { value, source: "document", documentId: e.document_id, documentType: e.document_type, extractionId: e.id, verified: false },
      ]);
      await tx`update document_extractions set conflict_id = ${open.id} where id = ${e.id}`;
      return { status: "conflict", fieldKey: e.field_key, conflictId: open.id };
    }

    const res = await updateFieldTx(
      tx,
      actor,
      { fieldKey: e.field_key, value, confirmOverwrite: false },
      { source: "document", userConfirmed: true, confidence: edited ? 1 : e.confidence === null ? null : Number(e.confidence), sourceDocumentId: e.document_id, reason: edited ? "document_value_edited" : "document_value_confirmed", ip },
    );

    if (res.status === "conflict") {
      // Profile already holds a different verified value: let the user choose.
      const [p] = await tx<{ value: string; is_encrypted: boolean; source_document_id: string | null; verified: boolean }[]>`
        select value, is_encrypted, source_document_id, verified from profile_fields
         where user_id = ${actor.id} and field_key = ${e.field_key} and deleted_at is null`;
      const conflictId = await upsertConflict(tx, actor.id, e.field_key, [
        { value: readStored(p!), source: "profile", documentId: p!.source_document_id, documentType: null, extractionId: null, verified: p!.verified },
        { value, source: "document", documentId: e.document_id, documentType: e.document_type, extractionId: e.id, verified: false },
      ]);
      await tx`update document_extractions set conflict_id = ${conflictId} where id = ${e.id}`;
      return { status: "conflict", fieldKey: e.field_key, conflictId };
    }

    await tx`
      update document_extractions
         set status = ${edited ? "EDITED" : "CONFIRMED"}, final_value = ${storeValue(e.field_key, value).value},
             reviewed_at = now(), reviewed_by = ${actor.id}
       where id = ${e.id}`;
    // Alternative candidates for the same field in this document are now superseded.
    await tx`
      update document_extractions set status = 'REJECTED', reviewed_at = now(), reviewed_by = ${actor.id}
       where document_id = ${e.document_id} and field_key = ${e.field_key} and status = 'PENDING' and id <> ${e.id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "document.extraction_confirmed", targetType: "document_extraction", targetId: e.id, subjectUserId: actor.id, ip, metadata: { fieldKey: e.field_key, edited } }, tx);
    return { status: res.status, fieldKey: e.field_key };
  });
}

export async function rejectExtraction(actor: Actor, extractionId: string, ip?: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`
      update document_extractions set status = 'REJECTED', reviewed_at = now(), reviewed_by = ${actor.id}
       where id = ${extractionId} and user_id = ${actor.id} and status = 'PENDING' returning field_key`;
    if (rows.length === 0) throw notFound("Pending value not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "document.extraction_rejected", targetType: "document_extraction", targetId: extractionId, subjectUserId: actor.id, ip, metadata: { fieldKey: rows[0]!.field_key } }, tx);
  });
}

// --- Conflicts --------------------------------------------------------------------

export async function listConflicts(actor: Actor): Promise<ConflictView[]> {
  return asUser(actor, async (tx) => {
    const rows = await tx<{ id: string; field_key: string; candidates: StoredCandidate[]; created_at: Date }[]>`
      select id, field_key, candidates, created_at from document_conflicts
       where user_id = ${actor.id} and status = 'OPEN' order by created_at`;
    return rows.map((r) => ({
      id: r.id,
      fieldKey: r.field_key,
      createdAt: r.created_at.toISOString(),
      candidates: r.candidates.map((c) => ({
        value: readStored(c),
        source: c.source,
        documentId: c.document_id,
        documentType: c.document_type,
        verified: c.verified,
      })),
    }));
  });
}

export async function resolveConflict(actor: Actor, conflictId: string, choice: { chosenIndex?: number; customValue?: string }, ip?: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const [c] = await tx<{ id: string; field_key: string; candidates: StoredCandidate[] }[]>`
      select id, field_key, candidates from document_conflicts
       where id = ${conflictId} and user_id = ${actor.id} and status = 'OPEN' for update`;
    if (!c) throw notFound("Conflict not found or already resolved");

    let value: string;
    let chosen: StoredCandidate | undefined;
    if (choice.customValue?.trim()) {
      value = choice.customValue.trim();
    } else if (choice.chosenIndex !== undefined && c.candidates[choice.chosenIndex]) {
      chosen = c.candidates[choice.chosenIndex]!;
      value = readStored(chosen);
    } else {
      throw badRequest("Choose one of the values or enter the correct one");
    }

    await updateFieldTx(
      tx,
      actor,
      { fieldKey: c.field_key, value, confirmOverwrite: true },
      { source: chosen?.source === "document" ? "document" : "user_input", userConfirmed: true, confidence: 1, sourceDocumentId: chosen?.document_id ?? null, reason: "conflict_resolved", ip },
    );

    const stored = storeValue(c.field_key, value);
    await tx`
      update document_conflicts
         set status = 'RESOLVED', resolved_value = ${stored.value}, resolved_source = ${chosen ? chosen.source : "user_input"},
             resolved_by = ${actor.id}, resolved_at = now()
       where id = ${c.id}`;

    // Settle every pending extraction of this field: matching ones confirmed, the rest rejected.
    const pending = await tx<{ id: string; extracted_value: string; is_encrypted: boolean }[]>`
      select id, extracted_value, is_encrypted from document_extractions
       where user_id = ${actor.id} and field_key = ${c.field_key} and status = 'PENDING'`;
    for (const p of pending) {
      const matches = normalizeValue(readStored({ value: p.extracted_value, is_encrypted: p.is_encrypted })) === normalizeValue(value);
      await tx`
        update document_extractions
           set status = ${matches ? "CONFIRMED" : "REJECTED"}, final_value = ${matches ? stored.value : null},
               reviewed_at = now(), reviewed_by = ${actor.id}, conflict_id = ${c.id}
         where id = ${p.id}`;
    }
    await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.conflict_resolved", targetType: "document_conflict", targetId: c.id, subjectUserId: actor.id, ip, metadata: { fieldKey: c.field_key, choice: chosen ? chosen.source : "custom" } }, tx);
  });
}

// --- Attach to a web page (extension) -----------------------------------------------

/** Documents that may be attached to a website's upload field: own, stored, not flagged by the virus scan. */
export async function listAttachableDocuments(actor: Actor) {
  const docs = await listDocuments(actor);
  return docs
    .filter((d) => d.scanStatus === "CLEAN" || d.scanStatus === "SKIPPED")
    .map((d) => ({ id: d.id, documentType: d.documentType, title: d.title, fileName: d.originalFilename, mimeType: d.mimeType, sizeBytes: d.sizeBytes }));
}

/**
 * The user clicked "Attach" for an upload field on `domain`: returns their own file
 * (never a café customer's) so the extension can put it into that field. Audited
 * with the website, so it shows up in the user's access history.
 */
export async function readDocumentForAttach(actor: Actor, id: string, domain: string, ip?: string): Promise<{ data: Buffer; mime: string; filename: string }> {
  const row = await asUser(actor, async (tx) => {
    const [r] = await tx<{ storage_key: string; mime_type: string; original_filename: string; scan_status: string }[]>`
      select storage_key, mime_type, original_filename, scan_status from documents
       where id = ${id} and user_id = ${actor.id} and deleted_at is null`;
    if (r && (r.scan_status === "CLEAN" || r.scan_status === "SKIPPED")) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: "document.attached_to_page", targetType: "document", targetId: id, subjectUserId: actor.id, ip, metadata: { domain } }, tx);
    }
    return r;
  });
  if (!row) throw notFound("Document not found");
  if (row.scan_status !== "CLEAN" && row.scan_status !== "SKIPPED") throw forbidden("This file has not passed the safety scan, so it cannot be attached.");
  return { data: await storage().get(row.storage_key), mime: row.mime_type, filename: row.original_filename };
}
