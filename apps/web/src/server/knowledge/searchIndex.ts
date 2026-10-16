import "server-only";
import { createHmac } from "node:crypto";
import { chunkDocument, indexTerms, termsOf, type PageText } from "@ufa/document-engine";
import type { TransactionSql } from "@ufa/db";
import { encryptValue, keyring } from "../db";

/**
 * Blind keyword index for document chunks (AI browser Phase 3).
 *
 * `terms` stores HMAC-SHA256(indexKey, userId + word), truncated to 96 bits, never the
 * word. The index key is derived from a data-encryption key (its id is kept per chunk), and
 * the user id is mixed in, so the same word gives different hashes for different users.
 * The database can match candidates by hash; only the app (holding the key) can decrypt
 * and rank the text. What it reveals: which chunks of ONE user share a word, and how many
 * distinct words a chunk has.
 */
const derived = new Map<string, Buffer>();

function indexKey(keyId: string): Buffer {
  let k = derived.get(keyId);
  if (!k) {
    const base = keyring().keys.get(keyId);
    if (!base) throw new Error(`Unknown encryption key id "${keyId}"`);
    k = createHmac("sha256", base).update("ufa:knowledge-search-index:v1").digest();
    derived.set(keyId, k);
  }
  return k;
}

export function hashTerm(keyId: string, userId: string, term: string): string {
  return createHmac("sha256", indexKey(keyId)).update(`${userId}\u0000${term}`).digest("base64url").slice(0, 16);
}

/** Hashes of a query's words under every key that may have indexed the user's chunks. */
export function queryHashes(userId: string, query: string, maxTerms = 20): string[] {
  const terms = [...new Set(termsOf(query))].slice(0, maxTerms);
  const out: string[] = [];
  for (const keyId of keyring().keys.keys()) for (const t of terms) out.push(hashTerm(keyId, userId, t));
  return out;
}

/**
 * Replaces a document's chunks (worker, system pool, inside the processing transaction:
 * a re-run after a crash simply rebuilds them).
 */
export async function storeChunks(tx: TransactionSql, doc: { id: string; user_id: string }, pages: PageText[]): Promise<{ chunkCount: number; truncated: boolean }> {
  const { chunks, truncated } = chunkDocument(pages);
  const keyId = keyring().primaryId;
  await tx`delete from document_chunks where document_id = ${doc.id}`;
  for (const c of chunks) {
    const terms = indexTerms(`${c.section ?? ""}\n${c.text}`).map((t) => hashTerm(keyId, doc.user_id, t));
    await tx`
      insert into document_chunks (user_id, document_id, chunk_index, page_number, section_encrypted, content_encrypted, char_count, token_count, index_key_id, terms)
      values (${doc.user_id}, ${doc.id}, ${c.index}, ${c.page}, ${c.section ? encryptValue(c.section) : null}, ${encryptValue(c.text)},
              ${c.text.length}, ${termsOf(c.text).length}, ${keyId}, ${terms}::text[])`;
  }
  return { chunkCount: chunks.length, truncated };
}
