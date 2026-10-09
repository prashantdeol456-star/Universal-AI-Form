import { getFieldDef, validateValue, type DocumentType } from "@ufa/shared";
import { allowedFieldsFor } from "../targets";
import type { LocalAIDocumentExtractor } from "./localAi";
import { extractWithRules } from "./rules";
import type { ExtractedCandidate } from "./types";

export * from "./types";
export { extractWithRules, toLines, labelValue, cleanName } from "./rules";
export { LocalAIDocumentExtractor, MAX_MODEL_CONFIDENCE, type LocalAIConfig } from "./localAi";

const norm = (v: string) => v.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** Validates/normalizes each candidate with the profile catalog's validator; drops invalid or disallowed ones. */
export function validateCandidates(type: DocumentType, candidates: ExtractedCandidate[]): ExtractedCandidate[] {
  const allowed = new Set(allowedFieldsFor(type));
  const out: ExtractedCandidate[] = [];
  for (const c of candidates) {
    if (!allowed.has(c.fieldKey)) continue;
    const def = getFieldDef(c.fieldKey);
    if (!def) continue;
    const r = validateValue(def.validator, c.value, { options: def.options });
    if (r.ok) out.push({ ...c, value: r.value, confidence: Math.round(c.confidence * 1000) / 1000 });
  }
  return out;
}

/** Keeps the highest-confidence candidate per (field, value). */
function dedupe(cands: ExtractedCandidate[]): ExtractedCandidate[] {
  const best = new Map<string, ExtractedCandidate>();
  for (const c of cands) {
    const k = `${c.fieldKey}\u0000${norm(c.value)}`;
    const prev = best.get(k);
    if (!prev || c.confidence > prev.confidence) best.set(k, c);
  }
  return [...best.values()];
}

/**
 * Combines rule and local-AI results per field:
 *  - agree    -> one candidate, confidence boosted (two independent methods agree)
 *  - disagree -> both kept with reduced confidence; the user picks
 *  - only one -> kept as is
 * If rules found several different values for one field, only the best is kept.
 */
export function mergeCandidates(rules: ExtractedCandidate[], ai: ExtractedCandidate[]): ExtractedCandidate[] {
  const byKey = (list: ExtractedCandidate[]) => {
    const m = new Map<string, ExtractedCandidate>();
    for (const c of list) {
      const prev = m.get(c.fieldKey);
      if (!prev || c.confidence > prev.confidence) m.set(c.fieldKey, c);
    }
    return m;
  };
  const r = byKey(rules);
  const a = byKey(ai);
  const out: ExtractedCandidate[] = [];
  for (const key of new Set([...r.keys(), ...a.keys()])) {
    const rc = r.get(key);
    const ac = a.get(key);
    if (rc && ac) {
      if (norm(rc.value) === norm(ac.value)) {
        out.push({ ...rc, confidence: Math.min(0.99, Math.max(rc.confidence, ac.confidence) + 0.05), method: "rules+local_ai" });
      } else {
        out.push({ ...rc, confidence: rc.confidence * 0.8 }, { ...ac, confidence: Math.min(ac.confidence, 0.6) });
      }
    } else {
      out.push((rc ?? ac)!);
    }
  }
  return out;
}

export interface ExtractionOutcome {
  candidates: ExtractedCandidate[];
  localAiUsed: boolean;
  localAiError?: string;
}

/**
 * Full extraction for one document's text. Local AI is optional: if it is
 * disabled or fails, rule results are still returned (no single point of failure).
 */
export async function extractFields(type: DocumentType, text: string, localAi?: LocalAIDocumentExtractor | null): Promise<ExtractionOutcome> {
  const rules = validateCandidates(type, extractWithRules(type, text));
  if (!localAi) return { candidates: dedupe(mergeCandidates(rules, [])), localAiUsed: false };
  try {
    const ai = validateCandidates(type, await localAi.extract(type, text, allowedFieldsFor(type)));
    return { candidates: dedupe(mergeCandidates(rules, ai)), localAiUsed: true };
  } catch (err) {
    return {
      candidates: dedupe(mergeCandidates(rules, [])),
      localAiUsed: false,
      localAiError: err instanceof Error ? err.message : String(err),
    };
  }
}
