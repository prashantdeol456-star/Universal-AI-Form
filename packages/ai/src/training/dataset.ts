import { fnv1a, normalizeLabel } from "@ufa/form-engine";
import { NOT_A_PROFILE_FIELD } from "../mapping/types";
import { localMappingSystemPrompt, localMappingUserPrompt, type PromptCandidate } from "../providers/prompt";

/**
 * Training-data preparation (spec §52, phase 11). Pure functions, so the whole
 * pipeline is unit-tested and reproducible:
 *
 *   eligible → clean (PII, unknown keys) → dedupe → resolve conflicts → split → chat records
 *
 * Input is learning examples: structure only (label, section, input type, option
 * labels, language, target key). A defence-in-depth PII check still drops any
 * example whose text looks like personal data (a label should never contain it).
 */

export interface RawExample {
  id: string;
  source: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REMOVED";
  contributorId: string | null;
  domain: string | null;
  label: string;
  section: string | null;
  type: string | null;
  options: string[];
  language: string;
  key: string;
}

export interface CleanExample {
  /** Learning example ids merged into this one (for traceability / removal). */
  ids: string[];
  label: string;
  normalizedLabel: string;
  section: string | null;
  type: string | null;
  options: string[];
  language: "en" | "hi";
  key: string;
  contributors: number;
  domains: number;
}

export type DropReason = "not_eligible" | "unknown_key" | "pii" | "empty_label" | "too_long" | "conflict";

const PII_PATTERNS: Array<[string, RegExp]> = [
  ["email", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/],
  ["ifsc", /\b[A-Z]{4}0[A-Z0-9]{6}\b/],
  ["long_number", /(?:\d[\s-]?){7,}/], // Aadhaar, phone, account, roll numbers: 7+ digits (spaces/dashes allowed)
];

/** True when text looks like it carries personal data. Labels like "Aadhaar Number" are fine; "Aadhaar 1234 5678 9012" is not. */
export function containsPII(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [name, re] of PII_PATTERNS) if (re.test(text)) return name;
  return null;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Which examples may be used. APPROVED (by an admin) always; PENDING only with
 * consensus — the same label→key confirmed by ≥ `minContributors` different
 * people — so one user can never put something into a dataset alone.
 */
export function eligibleExamples(raw: RawExample[], minContributors = 2): { eligible: RawExample[]; notEligible: number } {
  const votes = new Map<string, Set<string>>();
  for (const r of raw) {
    if (r.status !== "PENDING" || !r.contributorId) continue;
    const k = `${normalizeLabel(r.label)}|${r.key}`;
    let s = votes.get(k);
    if (!s) votes.set(k, (s = new Set()));
    s.add(r.contributorId);
  }
  const eligible = raw.filter(
    (r) => r.status === "APPROVED" || (r.status === "PENDING" && (votes.get(`${normalizeLabel(r.label)}|${r.key}`)?.size ?? 0) >= minContributors),
  );
  return { eligible, notEligible: raw.length - eligible.length };
}

export function cleanExamples(raw: RawExample[], isKnownKey: (key: string) => boolean): { kept: RawExample[]; dropped: Partial<Record<DropReason, number>> } {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => (dropped[r] = (dropped[r] ?? 0) + 1);
  const kept: RawExample[] = [];
  for (const r of raw) {
    const label = tidy(r.label);
    if (!label || !normalizeLabel(label)) {
      drop("empty_label");
      continue;
    }
    if (label.length > 150) {
      drop("too_long");
      continue;
    }
    if (r.key !== NOT_A_PROFILE_FIELD && !isKnownKey(r.key)) {
      drop("unknown_key");
      continue;
    }
    if (containsPII(label) || containsPII(r.section)) {
      drop("pii");
      continue;
    }
    kept.push({
      ...r,
      label,
      section: r.section ? tidy(r.section).slice(0, 120) || null : null,
      // Options that look personal are removed; the example stays.
      options: r.options.map(tidy).filter((o) => o && o.length <= 60 && !containsPII(o)).slice(0, 12),
    });
  }
  return { kept, dropped };
}

/**
 * Merges duplicates (same label, section, type, key) and resolves conflicts:
 * when the same field (label + section + type) points to different keys, the
 * majority key is kept only if it has ≥ 80 % of the contributors; otherwise the
 * field is dropped as ambiguous rather than teaching the model a coin flip.
 */
export function dedupeExamples(examples: RawExample[]): { examples: CleanExample[]; conflicts: number } {
  const byField = new Map<string, Map<string, RawExample[]>>();
  for (const e of examples) {
    const field = `${normalizeLabel(e.label)}|${normalizeLabel(e.section ?? "")}|${e.type ?? ""}`;
    let keys = byField.get(field);
    if (!keys) byField.set(field, (keys = new Map()));
    keys.set(e.key, [...(keys.get(e.key) ?? []), e]);
  }
  const out: CleanExample[] = [];
  let conflicts = 0;
  for (const keys of byField.values()) {
    const people = (rows: RawExample[]) => new Set(rows.map((r) => r.contributorId ?? r.id)).size;
    const ranked = [...keys.entries()].sort((a, b) => people(b[1]) - people(a[1]));
    const total = ranked.reduce((n, [, rows]) => n + people(rows), 0);
    const [key, rows] = ranked[0]!;
    if (ranked.length > 1 && people(rows) / total < 0.8) {
      conflicts++;
      continue;
    }
    const first = rows[0]!;
    out.push({
      ids: rows.map((r) => r.id),
      label: first.label,
      normalizedLabel: normalizeLabel(first.label),
      section: first.section,
      type: first.type,
      options: first.options,
      language: first.language === "hi" || /[ऀ-ॿ]/.test(first.label) ? "hi" : "en",
      key,
      contributors: people(rows),
      domains: new Set(rows.map((r) => r.domain).filter(Boolean)).size,
    });
  }
  return { examples: out.sort((a, b) => a.normalizedLabel.localeCompare(b.normalizedLabel) || a.key.localeCompare(b.key)), conflicts };
}

export type Split = "train" | "validation" | "test";

/**
 * Deterministic split by *label* (not by example): the same wording never appears
 * in both train and test, so the test set measures generalisation, not memory.
 */
export function splitOf(normalizedLabel: string, seed: string, ratios = { validation: 0.1, test: 0.1 }): Split {
  const h = parseInt(fnv1a(`${seed}|${normalizedLabel}`), 16) / 0xffffffff;
  if (h < ratios.test) return "test";
  if (h < ratios.test + ratios.validation) return "validation";
  return "train";
}

export interface ChatRecord {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/**
 * Chat-format training records in exactly the inference prompt (providers/prompt.ts).
 * Fields are grouped into small deterministic batches (like real forms), with
 * "none" as the target for non-profile fields, so the model learns to abstain.
 */
export function toChatRecords(examples: CleanExample[], candidates: PromptCandidate[], opts: { seed: string; batchSize?: number } = { seed: "v1" }): ChatRecord[] {
  const size = Math.max(1, Math.min(opts.batchSize ?? 6, 25));
  const ordered = [...examples].sort((a, b) => fnv1a(`${opts.seed}|${a.normalizedLabel}|${a.key}`).localeCompare(fnv1a(`${opts.seed}|${b.normalizedLabel}|${b.key}`)));
  const system = localMappingSystemPrompt(candidates);
  const records: ChatRecord[] = [];
  for (let i = 0; i < ordered.length; i += size) {
    const batch = ordered.slice(i, i + size).map((e, j) => ({ e, id: `f${j + 1}` }));
    records.push({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: localMappingUserPrompt(batch.map(({ e, id }) => ({ id, label: e.label, section: e.section, kind: e.type ?? "text", options: e.options }))),
        },
        {
          role: "assistant",
          content: JSON.stringify({
            mappings: batch.map(({ e, id }) => ({ field_id: id, profile_field: e.key === NOT_A_PROFILE_FIELD ? "none" : e.key, confidence: 0.95 })),
          }),
        },
      ],
    });
  }
  return records;
}

export interface DatasetReport {
  total: number;
  bySplit: Record<Split, number>;
  byLanguage: Record<string, number>;
  byCategory: Record<string, number>;
  byKey: Record<string, number>;
  noneShare: number;
  errors: string[];
  warnings: string[];
}

/** Checks a built dataset before it may be locked for training. */
export function validateDataset(
  examples: Array<CleanExample & { split: Split }>,
  opts: { minExamples?: number; maxClassShare?: number } = {},
): DatasetReport {
  const count = <K extends string>(f: (e: CleanExample & { split: Split }) => K) =>
    examples.reduce<Record<string, number>>((m, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {});
  const byKey = count((e) => e.key);
  const report: DatasetReport = {
    total: examples.length,
    bySplit: { train: 0, validation: 0, test: 0, ...count((e) => e.split) } as Record<Split, number>,
    byLanguage: count((e) => e.language),
    byCategory: count((e) => (e.key === NOT_A_PROFILE_FIELD ? "none" : e.key.split(".")[0]!)),
    byKey,
    noneShare: examples.length ? (byKey[NOT_A_PROFILE_FIELD] ?? 0) / examples.length : 0,
    errors: [],
    warnings: [],
  };
  const min = opts.minExamples ?? 50;
  if (examples.length < min) report.errors.push(`Only ${examples.length} examples (minimum ${min}). Collect more confirmations first.`);
  if (examples.some((e) => containsPII(e.label) || containsPII(e.section) || e.options.some((o) => containsPII(o)))) report.errors.push("Personal data detected in an example");
  if (!report.bySplit.test || !report.bySplit.train) report.errors.push("Train and test splits must both be non-empty");
  const maxShare = opts.maxClassShare ?? 0.3;
  for (const [k, n] of Object.entries(byKey)) if (examples.length >= min && n / examples.length > maxShare) report.warnings.push(`"${k}" is ${Math.round((n / examples.length) * 100)}% of the data (class imbalance)`);
  const rare = Object.entries(byKey).filter(([, n]) => n < 3).length;
  if (rare) report.warnings.push(`${rare} profile field(s) have fewer than 3 examples`);
  if (!report.byLanguage.hi) report.warnings.push("No Hindi examples");
  if (report.noneShare < 0.05) report.warnings.push("Few 'not a profile field' examples: the model may learn to never abstain");
  return report;
}
