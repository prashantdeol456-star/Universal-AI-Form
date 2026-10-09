import type { AIProvider } from "../providers/types";
import { referencePhrases, type Phrase } from "./fuzzy";

/**
 * Embedding-based semantic search (spec §22): labels are compared with the
 * reference phrasings of every profile field (in-process, computed once), and —
 * when a vector store is available (pgvector, phase 11) — with the shared,
 * verified labels learned from many users. The store is optional: without it,
 * or if it fails, search falls back to the in-process reference phrases.
 */
export interface SemanticHit {
  fieldKey: string;
  score: number;
  phrase: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Nearest stored label per query vector (cosine similarity in [0, 1]). */
export interface LabelVectorStore {
  nearest(vectors: number[][]): Promise<Array<SemanticHit | null>>;
}

export class SemanticIndex {
  private ref: Array<Phrase & { v: number[] }> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly provider: AIProvider,
    private readonly store: LabelVectorStore | null = null,
  ) {}

  private async ensure() {
    if (this.ref) return;
    this.loading ??= (async () => {
      const phrases = referencePhrases();
      const vectors: number[][] = [];
      for (let i = 0; i < phrases.length; i += 64) vectors.push(...(await this.provider.embed!(phrases.slice(i, i + 64).map((p) => p.text))));
      this.ref = phrases.map((p, i) => ({ ...p, v: vectors[i]! }));
    })().catch((err) => {
      this.loading = null;
      throw err;
    });
    await this.loading;
  }

  /** Best matching profile field per label (at most one hit per label). */
  async nearest(labels: string[]): Promise<Array<SemanticHit | null>> {
    if (!this.provider.embed || labels.length === 0) return labels.map(() => null);
    await this.ensure();
    const vs = await this.provider.embed(labels);
    const stored = this.store ? await this.store.nearest(vs).catch(() => vs.map(() => null)) : vs.map(() => null);
    return vs.map((v, i) => {
      let best: SemanticHit | null = stored[i] ?? null;
      for (const r of this.ref!) {
        const s = cosine(v, r.v);
        if (!best || s > best.score) best = { fieldKey: r.fieldKey, score: s, phrase: r.text };
      }
      return best;
    });
  }
}
