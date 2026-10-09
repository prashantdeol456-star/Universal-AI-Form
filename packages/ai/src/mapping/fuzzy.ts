import { normalizeLabel } from "@ufa/form-engine";
import { PROFILE_FIELDS } from "@ufa/shared";

/**
 * Reference phrasings for every profile field (catalog labels in English and
 * Hindi, catalog aliases, and common form wordings). Used by fuzzy matching now
 * and by embedding-based semantic search when a local model is available.
 */
const EXTRA_PHRASES: Record<string, string[]> = {
  "family.father_name": ["name of father", "fathers full name", "father name", "candidates fathers name", "pitaji ka naam", "पिताजी का नाम"],
  "family.mother_name": ["name of mother", "mothers full name", "mother name", "mata ka naam", "माँ का नाम"],
  "personal.full_name": ["name of candidate", "applicant name", "candidate name", "name of the applicant", "आवेदक का नाम", "अभ्यर्थी का नाम"],
  "personal.date_of_birth": ["dob", "birth date", "date of birth dd mm yyyy", "जन्म की तारीख"],
  "contact.address_line_1": ["permanent address", "correspondence address", "address for communication", "स्थायी पता", "पत्राचार का पता"],
  "contact.mobile": ["mobile no", "contact no", "phone no", "मोबाइल नंबर"],
  "contact.pincode": ["pin", "postal code", "zip"],
  "recruitment.category": ["category general obc sc st", "reservation category", "social category"],
  "recruitment.ex_serviceman": ["whether ex serviceman", "are you an ex serviceman", "esm status"],
  "education.highest_qualification": ["highest educational qualification", "qualification"],
};

export interface Phrase {
  fieldKey: string;
  text: string;
}

let cache: Phrase[] | null = null;
export function referencePhrases(): Phrase[] {
  if (cache) return cache;
  const out: Phrase[] = [];
  for (const def of PROFILE_FIELDS) {
    for (const t of [def.label.en, def.label.hi, ...(def.aliases ?? []), ...(EXTRA_PHRASES[def.key] ?? [])]) {
      const n = normalizeLabel(t);
      if (n) out.push({ fieldKey: def.key, text: n });
    }
  }
  cache = out;
  return out;
}

function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams: robust to typos and word-order changes. */
export function similarity(a: string, b: string): number {
  const A = trigrams(normalizeLabel(a));
  const B = trigrams(normalizeLabel(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Best fuzzy matches per profile field for a label. */
export function fuzzyMatches(label: string, minSimilarity = 0.62): Array<{ fieldKey: string; similarity: number; phrase: string }> {
  const best = new Map<string, { similarity: number; phrase: string }>();
  for (const p of referencePhrases()) {
    const s = similarity(label, p.text);
    if (s >= minSimilarity && s > (best.get(p.fieldKey)?.similarity ?? 0)) best.set(p.fieldKey, { similarity: s, phrase: p.text });
  }
  return [...best.entries()].map(([fieldKey, v]) => ({ fieldKey, ...v })).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}
