import "server-only";
import { getFieldDef } from "@ufa/shared";
import type { Sql, TransactionSql } from "@ufa/db";
import { decryptValue, encryptValue } from "../db";

/**
 * Stored shape of one candidate in document_conflicts.candidates.
 * `value` is encrypted when the field is sensitive.
 */
export interface StoredCandidate {
  value: string;
  is_encrypted: boolean;
  source: "profile" | "document";
  document_id: string | null;
  document_type: string | null;
  extraction_id: string | null;
  verified: boolean;
}

export interface PlainCandidate {
  value: string;
  source: "profile" | "document";
  documentId: string | null;
  documentType: string | null;
  extractionId: string | null;
  verified: boolean;
}

export const normalizeValue = (v: string) => v.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function isSensitiveKey(fieldKey: string): boolean {
  const def = getFieldDef(fieldKey);
  return def ? def.sensitivity !== "normal" : false;
}

export function storeValue(fieldKey: string, plain: string): { value: string; is_encrypted: boolean } {
  return isSensitiveKey(fieldKey) ? { value: encryptValue(plain), is_encrypted: true } : { value: plain, is_encrypted: false };
}

export function readStored(c: { value: string; is_encrypted: boolean }): string {
  return c.is_encrypted ? decryptValue(c.value) : c.value;
}

/** True when the candidate set holds at least two different values. */
export function hasDisagreement(values: string[]): boolean {
  return new Set(values.map(normalizeValue)).size > 1;
}

/**
 * Creates the OPEN conflict for (user, field) or merges new candidates into it
 * (one open conflict per field is enforced by a unique index). Works on either
 * the system pool (worker) or a user's RLS transaction.
 */
export async function upsertConflict(sql: Sql | TransactionSql, userId: string, fieldKey: string, candidates: PlainCandidate[]): Promise<string> {
  const [existing] = await sql<{ id: string; candidates: StoredCandidate[] }[]>`
    select id, candidates from document_conflicts
     where user_id = ${userId} and field_key = ${fieldKey} and status = 'OPEN'
     for update`;

  const merged: StoredCandidate[] = existing ? [...existing.candidates] : [];
  const seen = new Set(merged.map((c) => `${c.source}|${c.document_id ?? ""}|${normalizeValue(readStored(c))}`));
  for (const c of candidates) {
    const key = `${c.source}|${c.documentId ?? ""}|${normalizeValue(c.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...storeValue(fieldKey, c.value),
      source: c.source,
      document_id: c.documentId,
      document_type: c.documentType,
      extraction_id: c.extractionId,
      verified: c.verified,
    });
  }

  if (existing) {
    await sql`update document_conflicts set candidates = ${sql.json(merged as never)} where id = ${existing.id}`;
    return existing.id;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into document_conflicts (user_id, field_key, candidates)
    values (${userId}, ${fieldKey}, ${sql.json(merged as never)}) returning id`;
  return row!.id;
}
