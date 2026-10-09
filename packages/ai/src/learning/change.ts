/**
 * Form change detection (spec §58–59). Compares the fields of the form as it is
 * now with the form as it was when the user last applied, using field
 * signatures only (kind + name + normalised label hashes).
 *
 * Dynamic fields (District appears after State) must not look like a change, so
 * "new" means: not seen in *any* earlier version of this page, and "removed"
 * means: present in the version the user last applied on, but gone from every
 * version seen since.
 */
export interface FormChange {
  added: number;
  removed: number;
}

export function diffFormVersions(current: string[], knownBefore: string[], lastApplied: string[], seenSince: string[] = []): FormChange {
  const now = new Set(current);
  const known = new Set(knownBefore);
  const since = new Set([...current, ...seenSince]);
  return {
    added: [...now].filter((s) => !known.has(s)).length,
    removed: [...new Set(lastApplied)].filter((s) => !since.has(s)).length,
  };
}
