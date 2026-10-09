import type { Evidence, KnowledgeHit } from "./types";

/**
 * Independent confidence engine (spec §28). The score is computed from all
 * evidence, not taken from a model:
 *   positive evidence combines as a noisy-OR:  1 − Π(1 − wᵢ)
 *   negative evidence (user said "wrong", failure history) multiplies it down.
 * Model output is just one capped input (≤ 0.8 → weight ≤ 0.64).
 */
export function combine(evidence: Evidence[]): number {
  let miss = 1;
  let penalty = 1;
  for (const e of evidence) {
    if (e.weight >= 0) miss *= 1 - Math.min(e.weight, 0.99);
    else penalty *= 1 + Math.max(e.weight, -0.95);
  }
  return Math.round((1 - miss) * penalty * 1000) / 1000;
}

/** Evidence from the knowledge base (spec §24 priority: website > user > global). */
/** Knowledge about a form that has changed since is double-checked (weighed less). */
export const STALE_KNOWLEDGE_FACTOR = 0.85;

export function knowledgeEvidence(hit: KnowledgeHit): Evidence {
  const source = hit.scope === "WEBSITE" ? "kb_website" : hit.scope === "GLOBAL" ? "kb_global" : "kb_user";
  const detail = `${hit.scope.toLowerCase()} mapping (${hit.successCount}✓/${hit.failureCount}✗)`;
  // Only ever marked wrong: evidence against this field.
  if (hit.successCount === 0 && hit.failureCount > 0) return { source, weight: -0.6, detail };
  // Smoothed success rate; one explicit confirmation by a person already counts as reliable.
  const reliability = Math.min(1, (hit.successCount + 2) / (hit.successCount + hit.failureCount + 2));
  // A mapping that keeps failing turns into evidence against itself.
  if (reliability < 0.35) return { source, weight: -0.7, detail };
  const base = { WEBSITE: 0.95, USER: 0.94, USER_ANY_SITE: 0.8, GLOBAL: 0.88 }[hit.scope] * (hit.verified ? 1 : 0.6) * (hit.stale ? STALE_KNOWLEDGE_FACTOR : 1);
  return { source, weight: Math.round(base * reliability * 1000) / 1000, detail: hit.stale ? `${detail}, form changed` : detail };
}

/** True for evidence that a person verified this mapping (resolves label ambiguity). */
export function isVerifiedKnowledge(e: Evidence): boolean {
  return (e.source === "kb_user" || e.source === "kb_website") && e.weight >= 0.75;
}

export interface Thresholds {
  /** ≥ this: may auto-fill (AI_CONFIDENCE_THRESHOLD, default 0.90). */
  auto: number;
  /** ≥ this: suggest, user reviews; below: unknown (AI_FALLBACK_THRESHOLD, default 0.70). */
  review: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { auto: 0.9, review: 0.7 };
