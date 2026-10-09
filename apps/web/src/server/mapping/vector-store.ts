import "server-only";
import { NOT_A_PROFILE_FIELD, type AIProvider, type LabelVectorStore, type SemanticHit } from "@ufa/ai";
import { redact } from "@ufa/security";
import { db } from "../db";

/**
 * pgvector-backed label search (phase 11). Holds embeddings of *shared, verified*
 * field labels only (catalog phrasings + GLOBAL/WEBSITE knowledge) — never values
 * and never a user's personal mappings. Lives in the same PostgreSQL as everything
 * else: same backups, no extra service on the VPS.
 *
 * Optional: if the server has no pgvector (or the table is empty for this model),
 * `create` returns null and semantic search stays in-process.
 */
const DIMS = 768;
const g = globalThis as unknown as { __ufaVectorAvailable?: { at: number; ok: boolean } };

async function available(model: string): Promise<boolean> {
  const cached = g.__ufaVectorAvailable;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok;
  let ok = false;
  try {
    const [t] = await db().system<{ ok: boolean }[]>`select to_regclass('label_embeddings') is not null as ok`;
    if (t?.ok) {
      const [n] = await db().system<{ n: number }[]>`select count(*)::int as n from label_embeddings where model = ${model}`;
      ok = (n?.n ?? 0) > 0;
    }
  } catch {
    ok = false;
  }
  g.__ufaVectorAvailable = { at: Date.now(), ok };
  return ok;
}

export function pgVectorStore(model: string): LabelVectorStore {
  return {
    async nearest(vectors: number[][]): Promise<Array<SemanticHit | null>> {
      if (!(await available(model))) return vectors.map(() => null);
      const out: Array<SemanticHit | null> = [];
      for (const v of vectors) {
        if (v.length !== DIMS) {
          out.push(null);
          continue;
        }
        const lit = `[${v.join(",")}]`;
        const [row] = await db().system<{ profile_field_key: string; normalized_label: string; score: number }[]>`
          select profile_field_key, normalized_label, 1 - (embedding <=> ${lit}::vector) as score
            from label_embeddings where model = ${model}
           order by embedding <=> ${lit}::vector limit 1`;
        out.push(row ? { fieldKey: row.profile_field_key, score: Number(row.score), phrase: row.normalized_label } : null);
      }
      return out;
    },
  };
}

/**
 * Embeds shared, verified labels that are not in the store yet (called after each
 * learning run). Does nothing without pgvector or an embedding model.
 */
export async function syncSharedLabelEmbeddings(provider: AIProvider, model: string, limit = 200): Promise<number> {
  if (!provider.embed) return 0;
  try {
    const [t] = await db().system<{ ok: boolean }[]>`select to_regclass('label_embeddings') is not null as ok`;
    if (!t?.ok) return 0;
    const rows = await db().system<{ normalized_label: string; profile_field_key: string; scope: string }[]>`
      select distinct m.normalized_label, m.profile_field_key, lower(m.scope) as scope
        from form_mappings m
       where m.scope in ('GLOBAL', 'WEBSITE') and m.verified and m.profile_field_key <> ${NOT_A_PROFILE_FIELD}
         and not exists (select 1 from label_embeddings e
                          where e.normalized_label = m.normalized_label and e.profile_field_key = m.profile_field_key and e.model = ${model})
       limit ${limit}`;
    if (!rows.length) return 0;
    const vectors = await provider.embed(rows.map((r) => r.normalized_label));
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v || v.length !== DIMS) continue;
      await db().system`
        insert into label_embeddings (normalized_label, profile_field_key, source, model, embedding)
        values (${rows[i]!.normalized_label}, ${rows[i]!.profile_field_key}, ${rows[i]!.scope}, ${model}, ${`[${v.join(",")}]`}::vector)
        on conflict (normalized_label, profile_field_key, model) do nothing`;
      n++;
    }
    g.__ufaVectorAvailable = undefined;
    return n;
  } catch (err) {
    console.warn(`[vectors] sync skipped: ${redact(String(err)).slice(0, 200)}`);
    return 0;
  }
}
