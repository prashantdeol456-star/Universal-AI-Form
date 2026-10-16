/**
 * Personal knowledge base helpers (AI browser Phase 3): splitting document text into
 * chunks with page/section labels, normalising words for the search index, and ranking
 * candidate passages. Pure functions; storage, encryption and keyed hashing live in the
 * web server.
 */

export const CHUNK_LIMITS = {
  /** Target characters per chunk; paragraphs are kept whole when they fit. */
  targetChars: 1_000,
  maxChars: 1_600,
  maxChunks: 600,
} as const;

/**
 * Document types never added to the searchable knowledge base: images without text, and
 * identity or sensitive-category documents (their few facts live in the profile, where
 * every value is masked and confirmed one by one).
 */
export const KNOWLEDGE_EXCLUDED_TYPES: ReadonlySet<string> = new Set(["photograph", "signature", "aadhaar", "pan", "caste_certificate", "ews_certificate", "disability_certificate"]);

export interface PageText {
  /** 1-based page number, or null when the format has no pages (DOCX, TXT, images). */
  page: number | null;
  text: string;
}

export interface Chunk {
  index: number;
  page: number | null;
  /** The nearest heading above the chunk ("Work Experience"), if any. */
  section: string | null;
  text: string;
}

const RESUME_HEADINGS =
  /^(summary|profile|professional summary|objective|career objective|skills|key skills|technical skills|experience|work experience|professional experience|employment( history)?|projects?|education|academic( details| qualifications?)?|qualifications?|certifications?|achievements|awards|languages|personal (details|information)|contact( details)?|references|hobbies|interests)\s*:?$/i;

/** A short line that reads like a heading: "# …", "WORK EXPERIENCE", "Education:". */
export function headingOf(line: string): string | null {
  const t = line.trim();
  if (!t || t.length > 70) return null;
  if (/^#{1,3}\s+/.test(t)) return t.replace(/^#{1,3}\s+/, "").trim() || null;
  if (RESUME_HEADINGS.test(t)) return t.replace(/:$/, "").trim();
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 6 && !/[.,;]$/.test(t) && !/\d{3,}/.test(t)) return t.replace(/:$/, "");
  return null;
}

function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("; "));
    const at = cut > max * 0.5 ? cut + 1 : window.lastIndexOf(" ") > max * 0.5 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits pages into chunks of about `targetChars`, never across a page and starting a new
 * chunk at each heading, so a chunk can be cited as "page 2, Work Experience".
 */
export function chunkDocument(pages: PageText[], limits: { targetChars?: number; maxChars?: number; maxChunks?: number } = {}): { chunks: Chunk[]; truncated: boolean } {
  const target = limits.targetChars ?? CHUNK_LIMITS.targetChars;
  const max = limits.maxChars ?? CHUNK_LIMITS.maxChars;
  const maxChunks = limits.maxChunks ?? CHUNK_LIMITS.maxChunks;
  const chunks: Chunk[] = [];
  let truncated = false;
  let section: string | null = null;

  const push = (page: number | null, sec: string | null, text: string) => {
    const t = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) return;
    if (chunks.length >= maxChunks) {
      truncated = true;
      return;
    }
    chunks.push({ index: chunks.length, page, section: sec, text: t });
  };

  for (const p of pages) {
    let buf = "";
    let bufSection = section;
    const flush = () => {
      for (const part of splitLong(buf, max)) push(p.page, bufSection, part);
      buf = "";
    };
    for (const raw of p.text.split("\n")) {
      const line = raw.trimEnd();
      const h = headingOf(line);
      if (h) {
        flush();
        section = h.slice(0, 80);
        bufSection = section;
        buf = `${line.trim().replace(/^#{1,3}\s+/, "")}\n`;
        continue;
      }
      if (buf.length + line.length + 1 > target && buf.trim() && !/^\s*$/.test(line)) {
        // Prefer to break at a blank line or the end of a sentence.
        if (/[.!?:]\s*$/.test(buf.trimEnd()) || buf.length > max * 0.8) flush();
      }
      buf += `${line}\n`;
      if (buf.length > max) flush();
    }
    flush();
  }
  return { chunks, truncated };
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have i in is it its my of on or our that the their this to was were what when where which who will with you your me am do does did can could should would please find tell show give list use using about any all".split(" "),
);

/** Lowercase, NFKC, keeps letters (incl. Devanagari) and digits; light English suffix stripping. */
export function normalizeTerm(word: string): string | null {
  let w = word.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}+#.]/gu, "").replace(/^\.+|\.+$/g, "");
  if (w.length < 2 || w.length > 40 || STOPWORDS.has(w)) return null;
  if (/^[a-z]+$/.test(w) && w.length > 4) {
    if (w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith("ing") && w.length > 6) w = w.slice(0, -3);
    else if (w.endsWith("ed") && w.length > 5) w = w.slice(0, -2);
    else if (w.endsWith("es") && /(s|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  }
  return w;
}

/** Terms of a text, in order, with repeats (for scoring). */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s/,;:()[\]{}"'“”‘’!?|<>=*_~`\\-]+/)) {
    const t = normalizeTerm(raw);
    if (t) out.push(t);
  }
  return out;
}

/** Distinct terms for the search index (bounded). */
export function indexTerms(text: string, max = 400): string[] {
  return [...new Set(termsOf(text))].slice(0, max);
}

export interface Passage {
  id: string;
  text: string;
}

/**
 * BM25-style score of each passage for the query (k1 = 1.2, b = 0.75), with a bonus when
 * the query's words appear next to each other. Passages with no query word score 0.
 */
export function rankPassages(query: string, passages: Passage[]): Array<{ id: string; score: number; matched: string[] }> {
  const q = [...new Set(termsOf(query))];
  if (!q.length || !passages.length) return passages.map((p) => ({ id: p.id, score: 0, matched: [] }));
  const docs = passages.map((p) => ({ id: p.id, terms: termsOf(p.text) }));
  const avg = docs.reduce((s, d) => s + d.terms.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.terms.includes(t)).length]));
  const n = docs.length;
  const qPhrase = q.join(" ");
  return docs.map((d) => {
    let score = 0;
    const matched: string[] = [];
    for (const t of q) {
      const tf = d.terms.filter((x) => x === t).length;
      if (!tf) continue;
      matched.push(t);
      const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + 0.75 * (d.terms.length / avg)));
    }
    if (q.length > 1 && d.terms.join(" ").includes(qPhrase)) score *= 1.5;
    score *= 0.5 + 0.5 * (matched.length / q.length);
    return { id: d.id, score: Math.round(score * 1000) / 1000, matched };
  });
}

/** Up to `max` characters of `text` around the first query word, on word boundaries. */
export function excerptAround(text: string, query: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const words = termsOf(query);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w.slice(0, Math.max(3, w.length - 1)));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(max / 3));
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start;
  let end = Math.min(flat.length, start + max);
  if (end < flat.length) end = flat.lastIndexOf(" ", end) > start ? flat.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
