export type ChatLanguage = "en" | "hi" | "hinglish";

const HINGLISH_MARKERS =
  /\b(mera|meri|mere|mujhe|main|mai|hum|hoon|hun|hu|hai|hain|tha|thi|ka|ki|ke|naam|nam|pitaji|pita|mata|maa|janam|shaadi|shadi|saal|kya|nahi|nahin|haan|kar|liya|kiya|abhi|aur)\b/gi;

/** Picks the reply language from the user's own message. */
export function detectLanguage(text: string): ChatLanguage {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (devanagari > latin) return "hi";
  const markers = (text.match(HINGLISH_MARKERS) ?? []).length;
  return markers >= 2 ? "hinglish" : "en";
}

/** NFKC, unified quotes/apostrophes and collapsed whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
