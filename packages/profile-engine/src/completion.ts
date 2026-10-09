import { PROFILE_FIELDS, type ProfileCategory } from "@ufa/shared";

export interface CompletionInput {
  fieldKey: string;
  verified: boolean;
}

export interface CompletionReport {
  percent: number;
  verifiedPercent: number;
  coreTotal: number;
  coreFilled: number;
  missingCore: string[];
  byCategory: Partial<Record<ProfileCategory, { filled: number; total: number }>>;
}

/** Profile completion is measured against the catalog's `core` fields. */
export function computeCompletion(fields: CompletionInput[]): CompletionReport {
  const present = new Map(fields.map((f) => [f.fieldKey, f.verified]));
  const core = PROFILE_FIELDS.filter((d) => d.core);
  let filled = 0;
  let verified = 0;
  const missingCore: string[] = [];
  const byCategory: CompletionReport["byCategory"] = {};

  for (const d of core) {
    const cat = (byCategory[d.category] ??= { filled: 0, total: 0 });
    cat.total += 1;
    if (present.has(d.key)) {
      filled += 1;
      cat.filled += 1;
      if (present.get(d.key)) verified += 1;
    } else {
      missingCore.push(d.key);
    }
  }

  const pct = (n: number) => (core.length === 0 ? 100 : Math.round((n / core.length) * 100));
  return {
    percent: pct(filled),
    verifiedPercent: pct(verified),
    coreTotal: core.length,
    coreFilled: filled,
    missingCore,
    byCategory,
  };
}
