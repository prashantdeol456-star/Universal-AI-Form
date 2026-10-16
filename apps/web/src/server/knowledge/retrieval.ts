import "server-only";
import { excerptAround, rankPassages, termsOf } from "@ufa/document-engine";
import { getFieldDef, maskValue, PROFILE_FIELDS } from "@ufa/shared";
import { asUser, decryptValue, type Actor } from "../db";
import { normalizeValue, readStored } from "../documents/conflicts";
import { badRequest } from "../http";
import { queryHashes } from "./searchIndex";
import type { KnowledgeConflict, KnowledgeExcerpt, KnowledgeFact, RetrievalResult } from "./types";

/**
 * Personal knowledge retrieval (AI browser Phase 3). One typed entry point for the
 * dashboard search, document-backed answers, form mapping and, later, job matching and
 * reply drafting:
 *
 *   query → words → blind-index hashes → candidate chunks of THIS user (RLS + user_id)
 *         → decrypt candidates only → BM25-style ranking → bounded excerpts with sources
 *   + profile values and unconfirmed document values for fields the query names
 *   + conflicts when the user's sources disagree
 *
 * Nothing is invented: no hit means `not_found`.
 */
export const RETRIEVAL_LIMITS = {
  maxQueryChars: 300,
  maxQueryTerms: 20,
  /** Chunks fetched from the database for ranking. */
  candidates: 60,
  maxResults: 8,
  excerptChars: 600,
  maxFacts: 12,
} as const;

export interface RetrievalOptions {
  limit?: number;
  /** Only these documents (still the user's own). */
  documentIds?: string[];
  /** Also return profile values and unconfirmed extractions for fields the query names (default true). */
  includeFacts?: boolean;
  /** Return these profile fields as facts regardless of the query wording (form mapping). */
  fieldKeys?: string[];
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  page_number: number | null;
  section_encrypted: string | null;
  content_encrypted: string;
  title: string | null;
  original_filename: string;
  document_type: string;
  cloud_ai_allowed: boolean;
  hits: number;
}

/** Profile fields whose label, aliases or key share words with the query. */
export function fieldsForQuery(query: string, max = 6): string[] {
  const q = new Set(termsOf(query));
  if (!q.size) return [];
  const scored: Array<{ key: string; score: number }> = [];
  for (const f of PROFILE_FIELDS) {
    const words = new Set(termsOf([f.label.en, ...(f.aliases ?? []), f.key.replace(/[._]/g, " ")].join(" ")));
    let hit = 0;
    for (const w of q) if (words.has(w)) hit++;
    if (hit) scored.push({ key: f.key, score: hit / Math.sqrt(words.size) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.key);
}

export async function retrieve(actor: Actor, query: string, opts: RetrievalOptions = {}): Promise<RetrievalResult> {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) throw badRequest("Type what you are looking for");
  if (q.length > RETRIEVAL_LIMITS.maxQueryChars) throw badRequest(`Keep the question under ${RETRIEVAL_LIMITS.maxQueryChars} characters`);
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), RETRIEVAL_LIMITS.maxResults);
  const hashes = queryHashes(actor.id, q, RETRIEVAL_LIMITS.maxQueryTerms);
  const keys = [...new Set([...(opts.fieldKeys ?? []), ...(opts.includeFacts === false ? [] : fieldsForQuery(q))])].slice(0, RETRIEVAL_LIMITS.maxFacts);

  const { rows, profile, pending, openConflicts } = await asUser(actor, async (tx) => {
    const rows = hashes.length
      ? await tx<ChunkRow[]>`
          select c.id, c.document_id, c.chunk_index, c.page_number, c.section_encrypted, c.content_encrypted,
                 d.title, d.original_filename, d.document_type, d.cloud_ai_allowed,
                 (select count(*) from unnest(c.terms) t where t = any(${hashes}::text[]))::int as hits
            from document_chunks c
            join documents d on d.id = c.document_id and d.deleted_at is null
           where c.user_id = ${actor.id} and c.terms && ${hashes}::text[]
             ${opts.documentIds?.length ? tx`and c.document_id = any(${opts.documentIds}::uuid[])` : tx``}
           order by hits desc, c.document_id, c.chunk_index
           limit ${RETRIEVAL_LIMITS.candidates}`
      : [];
    if (!keys.length) return { rows, profile: [], pending: [], openConflicts: [] };
    const profile = await tx<{ field_key: string; value: string; is_encrypted: boolean; verified: boolean; source: string; source_document_id: string | null; doc_title: string | null }[]>`
      select p.field_key, p.value, p.is_encrypted, p.verified, p.source, p.source_document_id,
             coalesce(d.title, d.original_filename) as doc_title
        from profile_fields p left join documents d on d.id = p.source_document_id and d.deleted_at is null
       where p.user_id = ${actor.id} and p.deleted_at is null and p.field_key = any(${keys}::text[])`;
    const pending = await tx<{ field_key: string; extracted_value: string; is_encrypted: boolean; method: string; document_id: string; doc_title: string }[]>`
      select e.field_key, e.extracted_value, e.is_encrypted, e.method, e.document_id, coalesce(d.title, d.original_filename) as doc_title
        from document_extractions e join documents d on d.id = e.document_id and d.deleted_at is null
       where e.user_id = ${actor.id} and e.status = 'PENDING' and e.field_key = any(${keys}::text[])
       order by e.created_at desc limit 40`;
    const openConflicts = await tx<{ field_key: string }[]>`
      select field_key from document_conflicts where user_id = ${actor.id} and status = 'OPEN' and field_key = any(${keys}::text[])`;
    return { rows, profile, pending, openConflicts };
  });

  // Rank decrypted candidates.
  const decoded = rows.map((r) => ({ row: r, text: decryptValue(r.content_encrypted), section: r.section_encrypted ? decryptValue(r.section_encrypted) : null }));
  const ranked = rankPassages(
    q,
    decoded.map((d) => ({ id: d.row.id, text: `${d.section ?? ""}\n${d.text}` })),
  );
  const scoreOf = new Map(ranked.map((r) => [r.id, r.score]));
  const excerpts: KnowledgeExcerpt[] = decoded
    .filter((d) => (scoreOf.get(d.row.id) ?? 0) > 0)
    .sort((a, b) => scoreOf.get(b.row.id)! - scoreOf.get(a.row.id)!)
    .slice(0, limit)
    .map((d, i) => ({
      ref: `S${i + 1}`,
      documentId: d.row.document_id,
      documentTitle: d.row.title ?? d.row.original_filename,
      documentType: d.row.document_type,
      page: d.row.page_number,
      section: d.section,
      text: excerptAround(d.text, q, RETRIEVAL_LIMITS.excerptChars),
      score: scoreOf.get(d.row.id)!,
      cloudAiAllowed: d.row.cloud_ai_allowed,
    }));

  // Facts: confirmed profile values first, then values documents suggest but the user has not confirmed.
  const facts: KnowledgeFact[] = [];
  const show = (key: string, plain: string) => ((getFieldDef(key)?.sensitivity ?? "normal") !== "normal" ? maskValue(plain) : plain);
  for (const p of profile) {
    const plain = readStored(p);
    facts.push({
      key: p.field_key,
      label: getFieldDef(p.field_key)?.label.en ?? p.field_key,
      value: show(p.field_key, plain),
      sensitive: (getFieldDef(p.field_key)?.sensitivity ?? "normal") !== "normal",
      verified: p.verified,
      source: "profile",
      origin: p.source,
      sourceDocument: p.source_document_id && p.doc_title ? { id: p.source_document_id, title: p.doc_title } : null,
    });
  }
  const seen = new Set<string>();
  for (const e of pending) {
    const plain = readStored({ value: e.extracted_value, is_encrypted: e.is_encrypted });
    const dedupe = `${e.field_key}|${normalizeValue(plain)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    facts.push({
      key: e.field_key,
      label: getFieldDef(e.field_key)?.label.en ?? e.field_key,
      value: show(e.field_key, plain),
      sensitive: (getFieldDef(e.field_key)?.sensitivity ?? "normal") !== "normal",
      verified: false,
      source: "document_extraction",
      origin: e.method,
      sourceDocument: { id: e.document_id, title: e.doc_title },
    });
  }

  // Conflicts: an open document conflict, or different values among the facts for one field.
  // (Sensitive values are compared masked; their disagreements also arrive as open document conflicts.)
  const conflicts: KnowledgeConflict[] = [];
  for (const key of new Set(facts.map((f) => f.key))) {
    const mine = facts.filter((f) => f.key === key);
    const distinct = new Set(mine.map((f) => normalizeValue(f.value)));
    if (distinct.size > 1 || openConflicts.some((c) => c.field_key === key)) {
      conflicts.push({
        key,
        label: mine[0]!.label,
        values: mine.map((f) => ({ value: f.value, source: f.source === "profile" ? "Your profile" : "Document (not confirmed)", documentTitle: f.sourceDocument?.title ?? null, verified: f.verified })),
      });
    }
  }

  return { status: excerpts.length || facts.length ? "found" : "not_found", query: q, excerpts, facts, conflicts };
}
