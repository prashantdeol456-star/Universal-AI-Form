import { fnv1a } from "@ufa/form-engine";
import { NOT_A_PROFILE_FIELD } from "../mapping/types";

/**
 * Learning engine, decision part (spec §37–41, phase 9). Turns many users'
 * personal, verified field mappings into shared knowledge:
 *
 * - WEBSITE: "on this site, this exact field is X" — needs ≥ `websiteMinUsers`
 *   different people agreeing.
 * - GLOBAL: "a field labelled like this is X anywhere" — needs more people, on
 *   more than one website, near-unanimous, and a label that is specific enough.
 *
 * Votes carry no values and no user identity leaves this module: only the counts
 * of distinct users. A single user can never create shared knowledge alone.
 */

export interface MappingVote {
  userId: string;
  domain: string;
  fieldSignature: string;
  /** Raw label as seen on the page (structure only). */
  label: string;
  normalizedLabel: string;
  /** Profile field key, or NOT_A_PROFILE_FIELD. */
  key: string;
  /** +1: the user confirmed / successfully used this mapping. −1: the user marked it wrong. */
  polarity: 1 | -1;
}

export interface LearningConfig {
  websiteMinUsers: number;
  websiteMinAgreement: number;
  globalMinUsers: number;
  globalMinDomains: number;
  globalMinAgreement: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  websiteMinUsers: 2,
  websiteMinAgreement: 0.8,
  globalMinUsers: 3,
  globalMinDomains: 2,
  globalMinAgreement: 0.9,
};

export interface Promotion {
  scope: "WEBSITE" | "GLOBAL";
  domain: string | null;
  fieldSignature: string;
  fieldLabel: string;
  normalizedLabel: string;
  key: string;
  /** Distinct users supporting the key. */
  support: number;
  /** Distinct users disagreeing (other key, or marked this one wrong). */
  against: number;
  domains: number;
}

/** Words that are never specific enough to become a global pattern on their own. */
const VAGUE = new Set([
  "name", "number", "no", "date", "address", "details", "detail", "select", "other", "others", "yes", "id", "code", "type",
  "value", "field", "text", "please select", "choose", "remarks", "nam", "naam", "नाम", "पता", "तिथि", "संख्या",
]);

/** Labels that may be generalised across websites (specific, short, nothing that looks like personal data). */
export function isGeneralisableLabel(normalizedLabel: string): boolean {
  const l = normalizedLabel.trim();
  if (l.length < 3 || l.length > 80) return false;
  if (VAGUE.has(l)) return false;
  // Digit runs (roll numbers, years, phone numbers) or e-mail-like text: could be personal, never shared.
  if (/\d{3,}/.test(l) || l.includes("@")) return false;
  const words = l.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  // Single words: only distinctive ones ("nationality", "राष्ट्रीयता").
  return [...l].length >= 6;
}

interface Tally {
  supporters: Map<string, Set<string>>; // key → users who confirmed it
  rejecters: Map<string, Set<string>>; // key → users who marked it wrong
  labels: Map<string, number>; // raw label → count
  domains: Map<string, Set<string>>; // key → domains where confirmed
}

const tally = (): Tally => ({ supporters: new Map(), rejecters: new Map(), labels: new Map(), domains: new Map() });
const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
};

function winner(t: Tally): { key: string; support: number; against: number; domains: number } | null {
  let best: { key: string; support: number; against: number; domains: number } | null = null;
  for (const [key, users] of t.supporters) {
    const rejected = t.rejecters.get(key) ?? new Set<string>();
    const support = [...users].filter((u) => !rejected.has(u)).length;
    // Against: everyone who backed another key, plus everyone who rejected this one.
    const others = new Set<string>();
    for (const [k2, u2] of t.supporters) if (k2 !== key) u2.forEach((u) => others.add(u));
    rejected.forEach((u) => others.add(u));
    const against = [...others].filter((u) => !users.has(u) || rejected.has(u)).length;
    if (!best || support > best.support || (support === best.support && against < best.against)) {
      best = { key, support, against, domains: t.domains.get(key)?.size ?? 0 };
    }
  }
  return best;
}

const mostCommon = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";

function group(votes: MappingVote[], keyOf: (v: MappingVote) => string): Map<string, { tally: Tally; sample: MappingVote }> {
  const groups = new Map<string, { tally: Tally; sample: MappingVote }>();
  for (const v of votes) {
    const g = keyOf(v);
    let entry = groups.get(g);
    if (!entry) groups.set(g, (entry = { tally: tally(), sample: v }));
    const t = entry.tally;
    if (v.polarity === 1) {
      add(t.supporters, v.key, v.userId);
      add(t.domains, v.key, v.domain);
      t.labels.set(v.label, (t.labels.get(v.label) ?? 0) + 1);
    } else {
      add(t.rejecters, v.key, v.userId);
    }
  }
  return groups;
}

/** The global pattern's stable "signature": derived from the label, not from any one website. */
export const globalSignature = (normalizedLabel: string) => `g${fnv1a(normalizedLabel)}`;

export function decidePromotions(votes: MappingVote[], cfg: LearningConfig = DEFAULT_LEARNING_CONFIG): Promotion[] {
  const out: Promotion[] = [];

  for (const { tally: t, sample } of group(votes, (v) => `${v.domain}|${v.fieldSignature}`).values()) {
    const w = winner(t);
    if (!w || w.support < cfg.websiteMinUsers) continue;
    if (w.support / (w.support + w.against) < cfg.websiteMinAgreement) continue;
    out.push({
      scope: "WEBSITE",
      domain: sample.domain,
      fieldSignature: sample.fieldSignature,
      fieldLabel: mostCommon(t.labels) || sample.label,
      normalizedLabel: sample.normalizedLabel,
      key: w.key,
      support: w.support,
      against: w.against,
      domains: 1,
    });
  }

  for (const { tally: t, sample } of group(votes, (v) => v.normalizedLabel).values()) {
    if (!isGeneralisableLabel(sample.normalizedLabel)) continue;
    const w = winner(t);
    if (!w || w.key === NOT_A_PROFILE_FIELD) continue;
    if (w.support < cfg.globalMinUsers || w.domains < cfg.globalMinDomains) continue;
    if (w.support / (w.support + w.against) < cfg.globalMinAgreement) continue;
    out.push({
      scope: "GLOBAL",
      domain: null,
      fieldSignature: globalSignature(sample.normalizedLabel),
      fieldLabel: mostCommon(t.labels) || sample.label,
      normalizedLabel: sample.normalizedLabel,
      key: w.key,
      support: w.support,
      against: w.against,
      domains: w.domains,
    });
  }
  return out;
}

/** From a user's own form_mappings row to a vote (or nothing when it says nothing yet). */
export function voteFromUserMapping(r: {
  user_id: string;
  domain: string | null;
  field_signature: string;
  field_label: string;
  normalized_label: string;
  profile_field_key: string;
  verified: boolean;
  success_count: number;
  failure_count: number;
}): MappingVote | null {
  if (!r.domain) return null;
  let polarity: 1 | -1 | null = null;
  if (r.verified && r.success_count > r.failure_count) polarity = 1;
  else if (r.failure_count > r.success_count && r.success_count === 0) polarity = -1;
  if (!polarity) return null;
  return {
    userId: r.user_id,
    domain: r.domain,
    fieldSignature: r.field_signature,
    label: r.field_label,
    normalizedLabel: r.normalized_label,
    key: r.profile_field_key,
    polarity,
  };
}
