/** Text helpers shared by the DOM detector and the backend. No DOM access here. */

/** FNV-1a 32-bit, hex. Small, fast, deterministic — for signatures, not security. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Cleans a raw label: whitespace, required stars, trailing colons, numbering like "1." or "(a)". */
export function cleanLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKC")
    .replace(/[*✱]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:\(?[0-9]{1,2}[.)]|\(?[a-z][.)])\s+/i, "")
    .replace(/\s*[:：\-–]+\s*$/, "")
    .replace(/\s*\((?:required|mandatory|optional)\)\s*$/i, "")
    .trim()
    .slice(0, 200);
}

/** Lower-cased, punctuation-free label used for matching and signatures. */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[''`’]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** "fatherName" / "txt_father_nm" / "candidate-dob" -> "father name" / "father nm" / "candidate dob". */
export function humanizeIdentifier(id: string | null | undefined): string {
  if (!id) return "";
  return id
    .replace(/\[\d*\]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .replace(/\b(txt|tb|inp|input|fld|field|ddl|drp|cmb|chk|rb|rdo|ctl\d*|ctrl|cph\w*|main\w*content)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function detectLabelLanguage(label: string): "en" | "hi" | "mixed" {
  const deva = /[ऀ-ॿ]/.test(label);
  const latin = /[A-Za-z]/.test(label);
  return deva && latin ? "mixed" : deva ? "hi" : "en";
}

const CAPTCHA = /captcha|security\s*code|verification\s*code\s*(?:shown|in\s+the\s+image)|enter\s+(?:the\s+)?(?:characters|text|code)\s+(?:shown|in|from)|image\s*code|कैप्चा|सुरक्षा\s*कोड/i;
const OTP = /\botp\b|one[\s-]*time[\s-]*pass(?:word|code)|verification\s*code|ओटीपी/i;

export function manualReasonFor(label: string, extra: string): "captcha" | "otp" | null {
  const text = `${label} ${extra}`;
  if (CAPTCHA.test(text)) return "captcha";
  if (OTP.test(text)) return "otp";
  return null;
}

/** Strips the query string and fragment (they can carry session tokens). */
export function safePageUrl(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
