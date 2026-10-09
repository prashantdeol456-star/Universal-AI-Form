import { normalizeLabel } from "@ufa/form-engine";

/**
 * Matches a profile value to one of a form's options (spec §61), e.g. profile
 * "General" → option "UR", "Male" → "M", "no" → "No", "Graduation" → "Graduate".
 */
const SYNONYMS: string[][] = [
  ["general", "gen", "ur", "unreserved", "open", "oc", "सामान्य"],
  ["obc", "other backward class", "other backward classes", "obc ncl", "obc non creamy layer", "अन्य पिछड़ा वर्ग"],
  ["sc", "scheduled caste", "अनुसूचित जाति"],
  ["st", "scheduled tribe", "अनुसूचित जनजाति"],
  ["ews", "economically weaker section", "आर्थिक रूप से कमजोर वर्ग"],
  ["male", "m", "man", "boy", "पुरुष"],
  ["female", "f", "woman", "girl", "महिला"],
  ["transgender", "t", "third gender", "other", "तृतीय लिंग"],
  ["yes", "y", "true", "haan", "हाँ", "हां"],
  ["no", "n", "false", "nahi", "नहीं"],
  ["unmarried", "single", "never married", "अविवाहित"],
  ["married", "विवाहित"],
  ["widowed", "widow", "widower", "विधवा", "विधुर"],
  ["divorced", "तलाकशुदा"],
  ["indian", "india", "भारतीय"],
  ["class 10", "10th", "matriculation", "matric", "high school", "secondary", "ssc", "हाईस्कूल"],
  ["class 12", "12th", "intermediate", "senior secondary", "higher secondary", "hsc", "इंटरमीडिएट"],
  ["graduation", "graduate", "bachelors", "bachelor s degree", "ug", "degree", "स्नातक"],
  ["post graduation", "post graduate", "masters", "master s degree", "pg", "स्नातकोत्तर"],
  ["diploma", "डिप्लोमा"],
];

const GROUP = new Map<string, number>();
SYNONYMS.forEach((g, i) => g.forEach((w) => GROUP.set(normalizeLabel(w), i)));

export function matchOption(value: string, options: string[]): string | null {
  if (!options.length) return null;
  const v = normalizeLabel(value);
  if (!v) return null;
  const norm = options.map((o) => ({ o, n: normalizeLabel(o) }));
  const exact = norm.find((x) => x.n === v);
  if (exact) return exact.o;
  const g = GROUP.get(v);
  if (g !== undefined) {
    const syn = norm.find((x) => GROUP.get(x.n) === g || x.n.split(" ").some((w) => GROUP.get(w) === g && w.length > 1));
    if (syn) return syn.o;
  }
  // Long values: containment either way ("Uttar Pradesh" vs "UTTAR PRADESH (UP)").
  if (v.length >= 4) {
    const contains = norm.filter((x) => x.n.length >= 3 && (x.n.includes(v) || v.includes(x.n)));
    if (contains.length === 1) return contains[0]!.o;
  }
  return null;
}
