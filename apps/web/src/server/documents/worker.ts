import "server-only";
import {
  ClamAVScanner,
  detectFileType,
  extractFields,
  isExtractable,
  LocalAIDocumentExtractor,
  NoopScanner,
  type VirusScanner,
} from "@ufa/document-engine";
import { extractText, ScannedPdfError } from "@ufa/document-engine/ocr";
import type { DocumentType } from "@ufa/shared";
import { redact } from "@ufa/security";
import { audit } from "../audit";
import { notify } from "../notifications";
import { db, encryptValue } from "../db";
import { env } from "../env";
import { storage } from "../storage";
import { hasDisagreement, normalizeValue, readStored, storeValue, upsertConflict, type PlainCandidate } from "./conflicts";

/**
 * Background document processor, running inside the web process (started from
 * instrumentation.ts). PostgreSQL is the queue: documents in status UPLOADED are
 * claimed with FOR UPDATE SKIP LOCKED, so a second process could safely share the work.
 *
 *   scan → read text (PDF text layer / OCR) → rules (+ local AI) → validate →
 *   store PENDING extractions → flag conflicts → EXTRACTED
 *
 * Nothing is written to the profile here: every value waits for the user's confirmation.
 */
const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 15;

interface ClaimedDoc {
  id: string;
  user_id: string;
  document_type: DocumentType;
  storage_key: string;
  processing_attempts: number;
}

export async function requeueDocument(id: string): Promise<boolean> {
  const rows = await db().system`
    update documents set status = 'UPLOADED', processing_attempts = 0, processing_error = null, processing_started_at = null
     where id = ${id} and deleted_at is null and status in ('FAILED', 'EXTRACTED', 'VERIFIED') and scan_status <> 'INFECTED'
     returning id`;
  return rows.length > 0;
}

async function claimNext(): Promise<ClaimedDoc | null> {
  const [doc] = await db().system<ClaimedDoc[]>`
    update documents set status = 'PROCESSING', processing_started_at = now(), processing_attempts = processing_attempts + 1
     where id = (
       select id from documents
        where deleted_at is null and processing_attempts < ${MAX_ATTEMPTS}
          and (status = 'UPLOADED'
               or (status = 'PROCESSING' and processing_started_at < now() - make_interval(mins => ${STALE_MINUTES})))
        order by created_at
        for update skip locked
        limit 1)
     returning id, user_id, document_type, storage_key, processing_attempts`;
  return doc ?? null;
}

function scanner(): VirusScanner {
  const e = env();
  return e.CLAMAV_HOST ? new ClamAVScanner(e.CLAMAV_HOST, e.CLAMAV_PORT) : new NoopScanner();
}

function localAi(): LocalAIDocumentExtractor | null {
  const e = env();
  if (!e.LOCAL_AI_ENABLED) return null;
  return new LocalAIDocumentExtractor({ baseUrl: e.LOCAL_AI_BASE_URL, model: e.LOCAL_AI_MODEL, apiKey: e.LOCAL_AI_API_KEY, timeoutMs: e.OCR_TIMEOUT_MS });
}

async function fail(doc: ClaimedDoc, message: string, final: boolean) {
  await db().system`
    update documents set status = ${final ? "FAILED" : "UPLOADED"}, processing_error = ${message}, processing_started_at = null
     where id = ${doc.id}`;
}

export async function processDocument(doc: ClaimedDoc): Promise<void> {
  const sql = db().system;
  const buf = await storage().get(doc.storage_key);
  const type = detectFileType(buf);
  if (!type) return fail(doc, "Unsupported file type", true);

  // 1. Antivirus
  const scan = await scanner().scan(buf);
  await sql`update documents set scan_status = ${scan.status} where id = ${doc.id}`;
  if (scan.status === "INFECTED") {
    await storage().delete(doc.storage_key);
    await sql`update documents set status = 'FAILED', processing_error = 'Malware detected — the file was deleted', deleted_at = now() where id = ${doc.id}`;
    await audit({ actorId: null, actorRole: "SYSTEM", action: "security.malware_detected", targetType: "document", targetId: doc.id, subjectUserId: doc.user_id, metadata: { signature: scan.signature } });
    return;
  }
  if (scan.status === "ERROR") return fail(doc, "Virus scan unavailable, will retry", doc.processing_attempts >= MAX_ATTEMPTS);

  // 2. Photos, signatures, "other": stored for form uploads, no extraction.
  if (!isExtractable(doc.document_type)) {
    await sql`update documents set status = 'EXTRACTED', processed_at = now(), processing_error = null where id = ${doc.id}`;
    return;
  }

  // 3. Text
  let text;
  try {
    text = await extractText(buf, type, { timeoutMs: env().OCR_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ScannedPdfError) return fail(doc, err.message, true);
    throw err;
  }

  // 4. Fields (rules, optionally merged with local AI)
  const outcome = await extractFields(doc.document_type, text.text, localAi());
  if (outcome.localAiError) console.warn(`[documents] local AI unavailable for ${doc.id}: ${redact(outcome.localAiError)}`);

  // 5. Persist + 6. conflict detection, atomically.
  await sql.begin(async (tx) => {
    await tx`delete from document_extractions where document_id = ${doc.id} and status = 'PENDING'`;
    const inserted: Array<{ id: string; fieldKey: string; value: string }> = [];
    for (const c of outcome.candidates) {
      const stored = storeValue(c.fieldKey, c.value);
      const [row] = await tx<{ id: string }[]>`
        insert into document_extractions (document_id, user_id, field_key, extracted_value, is_encrypted, confidence, provider, model, method)
        values (${doc.id}, ${doc.user_id}, ${c.fieldKey}, ${stored.value}, ${stored.is_encrypted}, ${c.confidence},
                ${c.method === "rules" ? "rules" : "local_ai"}, ${c.method === "rules" ? null : env().LOCAL_AI_MODEL}, ${c.method})
        returning id`;
      inserted.push({ id: row!.id, fieldKey: c.fieldKey, value: c.value });
    }

    for (const fieldKey of new Set(inserted.map((i) => i.fieldKey))) {
      const mine = inserted.filter((i) => i.fieldKey === fieldKey);
      const [profile] = await tx<{ value: string; is_encrypted: boolean; verified: boolean; source_document_id: string | null }[]>`
        select value, is_encrypted, verified, source_document_id from profile_fields
         where user_id = ${doc.user_id} and field_key = ${fieldKey} and deleted_at is null`;
      const others = await tx<{ id: string; document_id: string; document_type: string; extracted_value: string; is_encrypted: boolean; final_value: string | null }[]>`
        select e.id, e.document_id, d.document_type, e.extracted_value, e.is_encrypted, e.final_value
          from document_extractions e join documents d on d.id = e.document_id
         where e.user_id = ${doc.user_id} and e.field_key = ${fieldKey} and e.document_id <> ${doc.id}
           and e.status in ('PENDING', 'CONFIRMED', 'EDITED') and d.deleted_at is null`;

      const external: PlainCandidate[] = [];
      if (profile) external.push({ value: readStored(profile), source: "profile", documentId: profile.source_document_id, documentType: null, extractionId: null, verified: profile.verified });
      for (const o of others) {
        const v = o.final_value ? readStored({ value: o.final_value, is_encrypted: o.is_encrypted }) : readStored({ value: o.extracted_value, is_encrypted: o.is_encrypted });
        external.push({ value: v, source: "document", documentId: o.document_id, documentType: o.document_type, extractionId: o.id, verified: false });
      }
      // Conflict only when this document disagrees with OTHER sources (not rules-vs-AI inside one document).
      const disagrees = mine.some((m) => external.some((x) => normalizeValue(x.value) !== normalizeValue(m.value)));
      if (!disagrees || !hasDisagreement([...external.map((x) => x.value), ...mine.map((m) => m.value)])) continue;

      const conflictId = await upsertConflict(tx, doc.user_id, fieldKey, [
        ...external,
        ...mine.map((m) => ({ value: m.value, source: "document" as const, documentId: doc.id, documentType: doc.document_type, extractionId: m.id, verified: false })),
      ]);
      await tx`update document_extractions set conflict_id = ${conflictId}
                where user_id = ${doc.user_id} and field_key = ${fieldKey} and status = 'PENDING'`;
    }

    await tx`
      update documents
         set status = 'EXTRACTED', processed_at = now(), processing_error = null, processing_started_at = null,
             extracted_text = ${encryptValue(text.text)}, text_engine = ${text.engine},
             text_confidence = ${text.confidence === null ? null : Math.round(text.confidence * 1000) / 1000},
             local_ai_used = ${outcome.localAiUsed}
       where id = ${doc.id}`;
  });
  await audit({ actorId: null, actorRole: "SYSTEM", action: "document.processed", targetType: "document", targetId: doc.id, subjectUserId: doc.user_id, metadata: { fields: outcome.candidates.length, engine: text.engine, localAi: outcome.localAiUsed } });
  await notify(doc.user_id, {
    type: "document_processed",
    title: "Your document has been read",
    body: outcome.candidates.length
      ? `${outcome.candidates.length} value${outcome.candidates.length === 1 ? " is" : "s are"} waiting for your confirmation.`
      : "No values could be read automatically. You can add them yourself.",
    link: `/dashboard/documents/${doc.id}`,
  }).catch(() => {});
}

// --- Loop ------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return redact(err.message || (err as { code?: string }).code || err.name);
  return redact(String(err));
}

const g = globalThis as unknown as { __ufaDocWorker?: { running: boolean; timer?: NodeJS.Timeout; wake: () => void; lastTickAt?: number } };

/** For the health check: is the worker running and ticking? */
export function documentWorkerHeartbeat(): { running: boolean; lastTickAt: number | null } {
  return { running: Boolean(g.__ufaDocWorker), lastTickAt: g.__ufaDocWorker?.lastTickAt ?? null };
}

async function drain() {
  const state = g.__ufaDocWorker!;
  state.lastTickAt = Date.now();
  if (state.running) return;
  state.running = true;
  try {
    for (let doc = await claimNext(); doc; doc = await claimNext()) {
      try {
        await processDocument(doc);
      } catch (err) {
        console.error(`[documents] processing ${doc.id} failed: ${describeError(err)}`);
        await fail(doc, "Processing failed. You can retry.", doc.processing_attempts >= MAX_ATTEMPTS).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[documents] worker error: ${describeError(err)}`);
  } finally {
    state.running = false;
  }
}

/** Starts the polling loop once per process. */
export function startDocumentWorker(intervalMs = 5_000) {
  if (g.__ufaDocWorker) return;
  g.__ufaDocWorker = { running: false, wake: () => void drain() };
  g.__ufaDocWorker.timer = setInterval(() => void drain(), intervalMs);
  g.__ufaDocWorker.timer.unref?.();
  void drain();
  console.info("[documents] background worker started");
}

/** Called after an upload so processing starts immediately instead of on the next poll. */
export function kickDocumentWorker() {
  if (env().DOCUMENT_WORKER_ENABLED) {
    if (!g.__ufaDocWorker) startDocumentWorker();
    else setImmediate(() => g.__ufaDocWorker?.wake());
  }
}
