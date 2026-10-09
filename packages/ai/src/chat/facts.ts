import { findState, getFieldDef, validateValue, verhoeffValid } from "@ufa/shared";
import { DATE_PATTERN, toDmy } from "./dates";
import { normalizeText } from "./language";

/**
 * Deterministic extraction of profile facts from what a user tells the
 * assistant, in English, Hindi (Devanagari) and Hinglish. Runs before (and
 * without) any model: fast, offline, predictable, and every fact still needs
 * the user's one-click confirmation before it reaches the profile.
 */
export interface ChatFact {
  fieldKey: string;
  value: string;
  confidence: number;
  method: "rules" | "local_ai";
  /** Exact text the value came from (used to mask sensitive values before storing the message). */
  raw: string;
}

type Push = (fieldKey: string, value: string | null | undefined, confidence: number, raw?: string) => void;

// --- Names ------------------------------------------------------------------------

const NAME_STOP = new Set([
  "and", "but", "he", "she", "who", "is", "was", "are", "has", "had", "my", "also", "please", "thanks", "thank", "sir", "madam",
  "aur", "hai", "h", "hain", "tha", "thi", "the", "ji", "hoon", "hu", "hun", "or", "with", "from", "in", "at", "since",
  "है", "और", "थे", "था", "जी", "हैं",
  // Question words: "मेरी माता का नाम क्या है?" / "father's name kya hai" are questions, not names.
  "what", "who", "which", "kya", "kaun", "kon", "क्या", "कौन",
]);
const NAME_PREFIX = /^(shri|sri|shree|smt|mr|mrs|ms|miss|dr|late|kumari|श्री|श्रीमती|स्व|स्वर्गीय|डॉ)\.?\s+/i;
const NOT_A_NAME = /^(a|an|the|not|no|retired|working|dead|alive|teacher|farmer|doctor|engineer|businessman|government|very|also|kisan|naukri)$/i;

/** Reads a person's name from the start of `rest`: up to 5 words, stopping at punctuation or connector words. */
export function takeName(rest: string, opts: { requireCapital?: boolean } = {}): { value: string; raw: string } | null {
  let s = rest.replace(/^[\s:=\-–"']+/, "");
  let prefix = NAME_PREFIX.exec(s);
  while (prefix) {
    s = s.slice(prefix[0].length);
    prefix = NAME_PREFIX.exec(s);
  }
  const words: string[] = [];
  for (const token of s.split(/\s+/)) {
    const w = token.replace(/[,.;!?।"')]+$/, "");
    if (!w || NAME_STOP.has(w.toLowerCase()) || !/^[\p{L}\p{M}][\p{L}\p{M}.'-]*$/u.test(w)) break;
    words.push(w);
    if (words.length === 5 || /[,.;!?।]$/.test(token)) break;
  }
  if (words.length === 0 || NOT_A_NAME.test(words[0]!)) return null;
  const raw = words.join(" ");
  const devanagari = /[ऀ-ॿ]/.test(raw);
  if (opts.requireCapital && !devanagari && !/^[A-Z]/.test(raw)) return null;
  // "raj kumar" -> "Raj Kumar"; keep the user's casing otherwise (e.g. "RAJ KUMAR").
  const value = !devanagari && raw === raw.toLowerCase() ? raw.replace(/(^|[\s.'-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase()) : raw;
  return { value, raw };
}

const REL: Array<[RegExp, string]> = [
  [/^(father|dad|daddy|papa|pita|pitaji|पिता|पिताजी|पापा)$/i, "family.father_name"],
  [/^(mother|mom|mum|mummy|mummi|maa|ma|mata|mataji|माता|माताजी|माँ|मां|मम्मी)$/i, "family.mother_name"],
  [/^(wife|husband|spouse|pati|patni|पति|पत्नी)$/i, "family.spouse_name"],
  [/^(guardian|abhibhavak|अभिभावक)$/i, "family.guardian_name"],
];
const REL_EN = "father|dad|daddy|papa|mother|mom|mum|mummy|wife|husband|spouse|guardian";
const REL_HINGLISH = "pita|pitaji|papa|father|dad|maa|mata|mataji|mummy|mummi|mother|pati|patni|wife|husband|abhibhavak|guardian";
const REL_HI = "पिता|पिताजी|पापा|माता|माताजी|माँ|मां|मम्मी|पति|पत्नी|अभिभावक";

function relationKey(word: string): string | null {
  for (const [re, key] of REL) if (re.test(word)) return key;
  return null;
}

function names(t: string, push: Push) {
  const forEach = (re: RegExp, fn: (m: RegExpExecArray, rest: string) => void) => {
    for (const m of t.matchAll(re)) fn(m as RegExpExecArray, t.slice(m.index! + m[0].length));
  };
  // "My father's (full) name is X", "Father name: X", "name of my father is X"
  forEach(new RegExp(`\\b(?:my\\s+)?(${REL_EN})(?:'s|s)?\\s+(?:full\\s+)?name\\s*(?:is|=|:|-)?\\s+`, "gi"), (m, rest) => {
    const n = takeName(rest);
    if (n) push(relationKey(m[1]!)!, n.value, 0.92, n.raw);
  });
  forEach(new RegExp(`\\bname\\s+of\\s+(?:my\\s+)?(${REL_EN})\\s+is\\s+`, "gi"), (m, rest) => {
    const n = takeName(rest);
    if (n) push(relationKey(m[1]!)!, n.value, 0.9, n.raw);
  });
  // "My father is Raj Kumar" (no "name": require a capitalised name to avoid "my father is a farmer")
  forEach(new RegExp(`\\bmy\\s+(${REL_EN})\\s+is\\s+`, "gi"), (m, rest) => {
    const n = takeName(rest, { requireCapital: true });
    if (n) push(relationKey(m[1]!)!, n.value, 0.75, n.raw);
  });
  // Hinglish: "mere papa ka naam Raj Kumar hai", "meri maa ka naam hai Sunita"
  forEach(new RegExp(`\\b(?:mere|meri|mera)?\\s*(${REL_HINGLISH})\\s*(?:ji\\s+)?(?:ka|ki|ke)\\s+(?:poora\\s+|pura\\s+|full\\s+)?(?:naam|nam|name)\\s+(?:hai\\s+|h\\s+)?`, "gi"), (m, rest) => {
    const n = takeName(rest);
    if (n) push(relationKey(m[1]!)!, n.value, 0.9, n.raw);
  });
  // Hindi: "मेरे पिता का नाम राज कुमार है"
  forEach(new RegExp(`(${REL_HI})\\s*(?:जी\\s+)?(?:का|की|के)\\s+(?:पूरा\\s+)?नाम\\s+(?:है\\s+)?`, "g"), (m, rest) => {
    const n = takeName(rest);
    if (n) push(relationKey(m[1]!)!, n.value, 0.9, n.raw);
  });
  // Own name
  forEach(/\bmy\s+(?:full\s+)?name\s*(?:is|=|:)\s+/gi, (_m, rest) => {
    const n = takeName(rest);
    if (n) push("personal.full_name", n.value, 0.9, n.raw);
  });
  forEach(/\b(?:mera|mra)\s+(?:poora\s+|pura\s+|full\s+)?(?:naam|nam|name)\s+(?:hai\s+)?/gi, (_m, rest) => {
    const n = takeName(rest);
    if (n) push("personal.full_name", n.value, 0.88, n.raw);
  });
  forEach(/मेरा\s+(?:पूरा\s+)?नाम\s+(?:है\s+)?/g, (_m, rest) => {
    const n = takeName(rest);
    if (n) push("personal.full_name", n.value, 0.88, n.raw);
  });
}

// --- Personal ----------------------------------------------------------------------

function dateOfBirth(t: string, push: Push) {
  if (!/\b(born|birth|dob|d\.o\.b|birthday|janam|janm|janamdin)\b|जन्म/i.test(t)) return;
  const m = DATE_PATTERN.exec(t);
  if (m) push("personal.date_of_birth", toDmy(m[1]!), 0.9, m[1]);
}

function gender(t: string, push: Push) {
  const en = /\bi\s*(?:am|'m)\s+(?:a\s+)?(male|female|man|woman|boy|girl|transgender)\b/i.exec(t) ?? /\bgender\s*(?:is|:|=)?\s*(male|female|transgender|other)\b/i.exec(t);
  const hinglish = /\b(?:main|mai|mein)\s+(?:ek\s+)?(ladka|ladki|purush|mahila)\s+(?:hoon|hun|hu)\b/i.exec(t);
  const hi = /(?:मैं\s+)?(पुरुष|महिला|लड़का|लड़की)\s+हूँ|(?:मैं\s+)?(पुरुष|महिला|लड़का|लड़की)\s+हूं/.exec(t);
  const word = (en?.[1] ?? hinglish?.[1] ?? hi?.[1] ?? hi?.[2])?.toLowerCase();
  if (!word) return;
  const map: Record<string, string> = {
    male: "Male", man: "Male", boy: "Male", ladka: "Male", purush: "Male", पुरुष: "Male", लड़का: "Male",
    female: "Female", woman: "Female", girl: "Female", ladki: "Female", mahila: "Female", महिला: "Female", लड़की: "Female",
    transgender: "Transgender", other: "Other",
  };
  push("personal.gender", map[word], 0.88);
}

function marital(t: string, push: Push) {
  let v: string | null = null;
  const en = /\bi\s*(?:am|'m)\s+(not\s+)?(married|unmarried|single|divorced|widowed|a\s+widow(?:er)?|separated)\b/i.exec(t);
  if (en) {
    const word = en[2]!.toLowerCase();
    if (en[1]) v = word === "married" ? "Unmarried" : null;
    else v = word === "married" ? "Married" : word === "unmarried" || word === "single" ? "Unmarried" : word === "divorced" ? "Divorced" : word === "separated" ? "Separated" : "Widowed";
  }
  const status = /\bmarital\s+status\s*(?:is|:|=)?\s*(married|unmarried|single|divorced|widowed|separated)\b/i.exec(t);
  if (status) v = status[1]!.toLowerCase() === "single" ? "Unmarried" : status[1]!;
  if (/\bi\s+(?:got|am\s+getting)\s+married\b/i.test(t) && !/getting/i.test(t)) v = "Married";
  if (/\b(shaadi|shadi)\s+(nahi|nahin)\s+(hui|huyi|hai)|\b(avivahit|kunwara|kunwari|kuwara|kuwari)\b/i.test(t)) v = "Unmarried";
  else if (/\b(shaadishuda|shadishuda|vivahit)\b|\b(shaadi|shadi)\s+(ho\s+(gayi|gai|chuki)|hui\s+hai)/i.test(t)) v = "Married";
  if (/अविवाहित/.test(t)) v = "Unmarried";
  else if (/(?:^|\s)(विवाहित|शादीशुदा)/.test(t)) v = "Married";
  if (v) push("personal.marital_status", v, 0.88);
}

function nationality(t: string, push: Push) {
  if (/\bi\s*(?:am|'m)\s+(?:an?\s+)?indian(?:\s+(?:citizen|national))?\b|\bnationality\s*(?:is|:|=)?\s*indian\b/i.test(t)) push("personal.nationality", "Indian", 0.85);
}

// --- Recruitment flags ----------------------------------------------------------------

function yesNoFlag(t: string, push: Push, fieldKey: string, subject: string) {
  const en = new RegExp(`\\bi\\s*(?:am|'m)\\s+(not\\s+)?(?:an?\\s+|from\\s+(?:the\\s+)?)?(?:${subject})\\b`, "i").exec(t);
  if (en) return push(fieldKey, en[1] ? "no" : "yes", 0.88);
  const label = new RegExp(`\\b(?:${subject})\\s*(?:status)?\\s*[:=-]\\s*(yes|no|haan|nahi)\\b`, "i").exec(t);
  if (label) return push(fieldKey, label[1]!, 0.88);
  const hinglish = new RegExp(`\\b(?:main|mai)\\s+(?:${subject})\\s+(nahi\\s+|nahin\\s+)?(?:hoon|hun|hu)\\b`, "i").exec(t);
  if (hinglish) push(fieldKey, hinglish[1] ? "no" : "yes", 0.85);
}

function recruitment(t: string, push: Push) {
  yesNoFlag(t, push, "recruitment.ex_serviceman", "ex[-\\s]?service\\s*man|ex[-\\s]?servicemen|former\\s+soldier|ex[-\\s]?army");
  yesNoFlag(t, push, "recruitment.government_employee", "(?:central\\s+|state\\s+)?(?:government|govt\\.?|sarkari)\\s+(?:employee|servant|karmachari)");
  yesNoFlag(t, push, "recruitment.pwd", "person\\s+with\\s+(?:a\\s+)?disabilit(?:y|ies)|pwd|pwbd|disabled|physically\\s+(?:challenged|handicapped)|divyang");
  yesNoFlag(t, push, "recruitment.ews", "ews|economically\\s+weaker\\s+section");

  const cat =
    /\b(?:my\s+)?(?:caste\s+|reservation\s+)?category\s*(?:is|:|=|-)?\s*(general|gen|ur|unreserved|obc|sc|st|ews)\b/i.exec(t) ??
    /\bi\s+(?:belong\s+to\s+|am\s+(?:from\s+)?)(?:the\s+)?(general|obc|sc|st|ews)\b(?:\s+category)?/i.exec(t) ??
    /(?:^|\s)(?:मेरी\s+)?(?:श्रेणी|वर्ग|कैटेगरी)\s+(सामान्य|ओबीसी|एससी|एसटी|ईडब्ल्यूएस)/.exec(t);
  if (cat) {
    const w = cat[1]!.toLowerCase();
    const map: Record<string, string> = { general: "General", gen: "General", ur: "General", unreserved: "General", सामान्य: "General", obc: "OBC", ओबीसी: "OBC", sc: "SC", एससी: "SC", st: "ST", एसटी: "ST", ews: "EWS", ईडब्ल्यूएस: "EWS" };
    push("recruitment.category", map[w], 0.88);
  }
}

// --- Employment ----------------------------------------------------------------------

function employment(t: string, push: Push) {
  if (/\b(fresher|no\s+(?:work\s+)?experience|koi\s+experience\s+nahi)\b/i.test(t)) push("employment.experience_years", "0", 0.85);
  const exp =
    /\b(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?|saal|sal)\s+(?:of\s+)?(?:total\s+|work\s+|job\s+|ka\s+)?(?:experience|exp\b|anubhav)/i.exec(t) ??
    /\bexperience\s+(?:of\s+|is\s+)?(\d{1,2}(?:\.\d{1,2})?)\s*(?:years?|yrs?)/i.exec(t) ??
    /(\d{1,2})\s*(?:वर्ष|साल)\s+का\s+अनुभव/.exec(t);
  if (exp) push("employment.experience_years", exp[1], 0.88, exp[0]);

  const work = /\b[Ii]\s+(?:currently\s+)?(?:work|am\s+working|'m\s+working)\s+(?:at|in|with|for)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,5})(?:\s+as\s+(?:an?\s+)?([A-Za-z][A-Za-z.&-]*(?:\s+[A-Za-z][A-Za-z.&-]*){0,4}?))?(?=[,.;!?]|\s+(?:and|since|from|in|for)\b|$)/.exec(t);
  if (work && !/^(the\s+)?(government|govt)$/i.test(work[1]!)) {
    push("employment.company", work[1], 0.75);
    if (work[2]) push("employment.designation", work[2], 0.7);
  }
  const role = /\b[Ii]\s*(?:am|'m)\s+(?:an?\s+)([A-Za-z][A-Za-z.-]*(?:\s+[A-Za-z][A-Za-z.-]*){0,3}?)\s+(?:at|in|with)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,5})(?=[,.;!?]|\s+(?:and|since|from)\b|$)/.exec(t);
  if (role && !/^(student|resident)$/i.test(role[1]!)) {
    push("employment.designation", role[1], 0.7);
    push("employment.company", role[2], 0.7);
  }
}

// --- Education -----------------------------------------------------------------------

interface CourseHit {
  index: number;
  level: "class_10" | "class_12" | "graduation" | "post_graduation" | "diploma";
  course: string | null;
}

const COURSE_CANON: Record<string, string> = {
  bcom: "B.Com", bsc: "B.Sc", ba: "B.A", bca: "BCA", bba: "BBA", btech: "B.Tech", be: "B.E", bed: "B.Ed", bpharm: "B.Pharm",
  llb: "LLB", mbbs: "MBBS", mcom: "M.Com", msc: "M.Sc", ma: "M.A", mca: "MCA", mba: "MBA", mtech: "M.Tech", me: "M.E",
  med: "M.Ed", llm: "LLM",
};

function courseHits(t: string): CourseHit[] {
  const hits: CourseHit[] = [];
  const add = (re: RegExp, level: CourseHit["level"], name?: (m: RegExpMatchArray) => string | null) => {
    for (const m of t.matchAll(re)) hits.push({ index: m.index!, level, course: name ? name(m) : null });
  };
  add(/\b(?:10th|tenth|class\s*(?:10|x)\b|matric(?:ulation)?|high\s*school)|(?:^|\s)(?:दसवीं|हाईस्कूल|10वीं)/gi, "class_10");
  add(/\b(?:12th|twelfth|class\s*(?:12|xii)\b|intermediate|senior\s*secondary|higher\s*secondary)|(?:^|\s)(?:बारहवीं|इंटर|12वीं)/gi, "class_12");
  const canon = (m: RegExpMatchArray) => COURSE_CANON[m[1]!.toLowerCase().replace(/[.\s]/g, "")] ?? null;
  add(/\b(b\.?\s?com|b\.?\s?sc|bca|bba|b\.?\s?tech|b\.?\s?ed|b\.?\s?pharm|llb|mbbs)\b/gi, "graduation", canon);
  add(/\b(B\.A|B\.E|BA|BE)\b/g, "graduation", canon); // short forms: uppercase only
  add(/\b(m\.?\s?com|m\.?\s?sc|mca|mba|m\.?\s?tech|m\.?\s?ed|llm)\b/gi, "post_graduation", canon);
  add(/\b(M\.A|M\.E|MA|ME)\b/g, "post_graduation", canon);
  add(/\b(bachelor(?:'s)?\s+(?:of|in)\s+[a-z]+(?:\s+[a-z]+)?)/gi, "graduation", (m) => m[1]!.replace(/'s/, "").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Of|In)\b/, (w) => w.toLowerCase()));
  add(/\b(master(?:'s)?\s+(?:of|in)\s+[a-z]+(?:\s+[a-z]+)?)/gi, "post_graduation", (m) => m[1]!.replace(/'s/, "").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Of|In)\b/, (w) => w.toLowerCase()));
  add(/\b(diploma(?:\s+in\s+[a-z]+(?:\s+[a-z]+)?)?)/gi, "diploma", (m) => m[1]!.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bIn\b/, "in"));
  return hits.sort((a, b) => a.index - b.index);
}

function education(input: string, push: Push) {
  // Blank out dates first so "May 12th, 2001" is not read as "12th" (class 12).
  const t = input.replace(new RegExp(DATE_PATTERN.source, "gi"), (m) => " ".repeat(m.length));
  if (/\b(doing|pursuing|will\s+do|want\s+to|plan(?:ning)?\s+to|kar\s+(?:raha|rahi)|karna\s+hai)\b/i.test(t)) return;
  const completed = /\b(completed|complete|did|finished|passed|pass|done|cleared|graduated|kiya|ki\s+hai|kar\s+liya|have)\b|(?:^|\s)(किया|उत्तीर्ण|पास)/i.test(t);
  const hits = courseHits(t);
  hits.forEach((h, i) => {
    const seg = t.slice(h.index, hits[i + 1]?.index ?? t.length);
    // Hinglish often puts the year first: "Maine 2022 mein B.Com kiya".
    const before = i === 0 ? t.slice(0, h.index) : "";
    const year = /\b(19[5-9]\d|20\d{2})\b/.exec(seg)?.[1] ?? /\b(19[5-9]\d|20\d{2})\b/.exec(before)?.[1];
    if (!completed && !year) return;
    const base = `education.${h.level}`;
    const conf = completed && year ? 0.88 : 0.78;
    if (h.course && h.level !== "class_10" && h.level !== "class_12") push(`${base}.course`, h.course, conf);
    if (year) push(`${base}.passing_year`, year, conf);
    const pct = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent\b|percentage\b|pratishat\b|प्रतिशत)/i.exec(seg);
    if (pct) push(`${base}.percentage`, pct[1], conf);
    const cgpa = /\b(?:cgpa|gpa|sgpa|cpi)\s*(?:of\s+|is\s+|:\s*)?(\d{1,2}(?:\.\d{1,2})?)\b/i.exec(seg) ?? /\b(\d(?:\.\d{1,2})?)\s*(?:cgpa|gpa)\b/i.exec(seg);
    if (cgpa && h.level !== "class_10" && h.level !== "class_12") push(`${base}.cgpa`, cgpa[1], conf);
    const uni = /\bfrom\s+((?:the\s+)?(?:[A-Z][\w.&'-]*\s+){0,5}(?:University|Vishwavidyalaya|Institute|College)(?:\s+of(?:\s+[A-Z][\w.&'-]*){1,4})?)/.exec(seg) ??
      /\bfrom\s+(University\s+of(?:\s+[A-Z][\w.&'-]*){1,4})/.exec(seg);
    if (uni && h.level !== "class_10" && h.level !== "class_12") {
      push(`${base}.${/University|Vishwavidyalaya/.test(uni[1]!) ? "university" : "college"}`, uni[1]!.replace(/^the\s+/i, ""), 0.75);
    }
  });
}

// --- Contact ------------------------------------------------------------------------

function contact(t: string, push: Push) {
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(t);
  if (email) push("contact.email", email[0], 0.88, email[0]);

  if (/\b(mobile|phone|number|contact|whatsapp|mob|cell)\b|मोबाइल|फ़ोन|फोन|नंबर/i.test(t)) {
    for (const m of t.matchAll(/(?<!\d)((?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5})(?!\d)/g)) {
      const before = t.slice(Math.max(0, m.index! - 30), m.index!);
      const alt = /\b(alternate|alternative|another|second|other|dusra|doosra)\b/i.test(before);
      push(alt ? "contact.alternate_mobile" : "contact.mobile", m[1], 0.88, m[1]);
    }
  }

  const addr =
    /\b(?:my\s+)?(?:permanent\s+|current\s+|home\s+|residential\s+)?address\s*(?:is|:|=|-)\s*(.+)/i.exec(t) ??
    /\b(?:mera|meri)\s+(?:permanent\s+|sthayi\s+)?(?:address|pata)\s+(?:hai\s+)?(.+)/i.exec(t) ??
    /(?:मेरा\s+(?:स्थायी\s+)?पता|स्थायी\s+पता)\s+(?:है\s+)?(.+)/.exec(t);
  if (addr) {
    const value = addr[1]!
      .split(/\b(?:and\s+)?my\s+(?:mobile|phone|email|father|mother|name|dob|date)\b/i)[0]!
      .replace(/\s+(hai|है)\s*[.।]?$/i, "")
      .replace(/[\s.,।]+$/, "")
      .slice(0, 200);
    if (value.length >= 8) {
      push("contact.address_line_1", value, 0.82);
      const pin = /(?<!\d)([1-9]\d{5})(?!\d)/.exec(value);
      if (pin) push("contact.pincode", pin[1], 0.85);
      const state = findState(value);
      if (state) push("contact.state", state, 0.75);
    }
  }

  const live =
    /\b[Ii]\s+(?:live|stay|reside)\s+in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})(?=[,.;!?]|\s+(?:and|with|since)\b|$)/.exec(t) ??
    /\b[Ii]\s*(?:am|'m)\s+from\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})(?=[,.;!?]|\s+(?:and|with)\b|$)/.exec(t) ??
    /\b(?:main|mai)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+(?:mein|me|mai)\s+(?:rehta|rehti|rahta|rahti)/.exec(t);
  if (live && !addr) {
    const place = live[1]!;
    const state = findState(place);
    if (state && state.toLowerCase() === place.toLowerCase()) push("contact.state", state, 0.75);
    else {
      push("contact.city", place, 0.65);
      const after = t.slice(live.index! + live[0].length, live.index! + live[0].length + 40);
      const s2 = findState(after);
      if (s2) push("contact.state", s2, 0.7);
    }
  }
}

// --- Identity (sensitive: masked before the message is stored) -------------------------

function identity(t: string, push: Push) {
  if (/\bpan\b|पैन/i.test(t)) {
    const pan = /\b([A-Za-z]{5}\d{4}[A-Za-z])\b/.exec(t);
    if (pan) push("identity.pan_number", pan[1]!.toUpperCase(), 0.92, pan[1]);
  }
  if (/\b(aadhaar|aadhar|adhaar|adhar|uid)\b|आधार/i.test(t)) {
    for (const m of t.matchAll(/(?<!\d)([2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4})(?!\d)/g)) {
      if (verhoeffValid(m[1]!.replace(/\D/g, ""))) {
        push("identity.aadhaar_number", m[1], 0.92, m[1]);
        break;
      }
    }
  }
  if (/\bpassport\b|पासपोर्ट/i.test(t)) {
    const p = /\b([A-PR-WYa-pr-wy][1-9]\d{6})\b/.exec(t);
    if (p) push("identity.passport_number", p[1]!.toUpperCase(), 0.88, p[1]);
  }
  if (/\b(voter|epic)\b|मतदाता/i.test(t)) {
    const v = /\b([A-Za-z]{3}\d{7})\b/.exec(t);
    if (v) push("identity.voter_id", v[1]!.toUpperCase(), 0.88, v[1]);
  }
  if (/\b(account|a\/c|khata)\b|खाता/i.test(t)) {
    const a = /(?<!\d)(\d{9,18})(?!\d)/.exec(t.replace(/(\d)\s(?=\d)/g, "$1"));
    if (a) push("bank.account_number", a[1], 0.85, a[1]);
  }
  const ifsc = /\b([A-Za-z]{4}0[A-Za-z0-9]{6})\b/.exec(t);
  if (ifsc && /\bifsc\b/i.test(t)) push("bank.ifsc", ifsc[1]!.toUpperCase(), 0.9, ifsc[1]);
}

// --- Job search (assistant in the extension) ------------------------------------------

/** Text after "<topic> (is|hai|:)" up to the end of the clause. */
function after(t: string, topic: RegExp): string | null {
  const m = new RegExp(`(?:${topic.source})\\s*(?:is|are|=|:|-|hai|h|hain|hai\\s*ki)?\\s+(.+?)(?:\\s+(?:hai|h|hain)\\b)?(?=[.;\\n]|\\s+(?:and|aur)\\s+(?:i|my|me|mera|meri|mere)\\b|$)`, "i").exec(t);
  return m?.[1]?.trim().replace(/[,\s]+$/, "") || null;
}

function jobSearch(t: string, push: Push) {
  const city = after(t, /(?:current\s+|present\s+)?(?:city|location|shahar|शहर)|(?:i\s+(?:live|stay)|rehta\s+hoon|rehti\s+hoon)\s+in/);
  // The older contact rule also reads "I live in X, State"; this one only fills the gaps (lower confidence, city part only).
  if (city && city.length <= 60 && !/\d{3}/.test(city)) push("contact.city", city.split(",")[0]!.replace(/^(in|me|mein)\s+/i, "").replace(/\b\w/g, (c) => c.toUpperCase()), 0.6);
  const notice = after(t, /notice\s+period/);
  if (notice && notice.length <= 40) push("employment.notice_period", notice, 0.85);
  const expected = after(t, /(?:expected|desired)\s+(?:salary|ctc|package)|salary\s+expectation/);
  if (expected && expected.length <= 40) push("employment.desired_salary", expected, 0.85);
  const skills = after(t, /(?:my\s+|mere\s+)?(?:key\s+)?skills/);
  if (skills && skills.length >= 3) push("employment.skills", skills.slice(0, 500), 0.75);
  const linkedin = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}/i.exec(t)?.[0];
  if (linkedin) push("employment.linkedin_url", /^https?:/i.test(linkedin) ? linkedin : `https://${linkedin}`, 0.95);
  const relocate = /\b(?:willing|ready|open)\s+to\s+relocate\b|relocate\s+(?:kar\s+sakta|kar\s+sakti|ho\s+sakta)/i.test(t) ? "yes" : /\b(?:not|nahi|can'?t)\s+(?:willing\s+to\s+)?relocate\b/i.test(t) ? "no" : null;
  if (relocate) push("employment.willing_to_relocate", relocate, 0.85);
}

// --- Entry point --------------------------------------------------------------------

/** Extracts facts, validates them with the profile catalog, and keeps the best value per field. */
export function extractChatFacts(input: string): ChatFact[] {
  const t = normalizeText(input);
  const found: ChatFact[] = [];
  const push: Push = (fieldKey, value, confidence, raw) => {
    if (!value) return;
    const def = getFieldDef(fieldKey);
    if (!def) return;
    const r = validateValue(def.validator, value, { options: def.options });
    if (!r.ok) return;
    found.push({ fieldKey, value: r.value, confidence, method: "rules", raw: raw ?? value });
  };
  names(t, push);
  dateOfBirth(t, push);
  gender(t, push);
  marital(t, push);
  nationality(t, push);
  recruitment(t, push);
  employment(t, push);
  education(t, push);
  contact(t, push);
  identity(t, push);
  jobSearch(t, push);

  const best = new Map<string, ChatFact>();
  for (const f of found) {
    const prev = best.get(f.fieldKey);
    if (!prev || f.confidence > prev.confidence) best.set(f.fieldKey, f);
  }
  return [...best.values()];
}
