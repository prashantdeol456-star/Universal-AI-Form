/**
 * Which of the user's documents fits a website's upload field ("Upload your
 * resume", "Photograph", "Signature", …). Only a suggestion: the user picks the
 * document and clicks Attach in the side panel.
 */
export type SuggestedDocument =
  | "resume"
  | "photograph"
  | "signature"
  | "aadhaar"
  | "pan"
  | "class_10_marksheet"
  | "class_12_marksheet"
  | "graduation_marksheet"
  | "degree"
  | "caste_certificate"
  | "experience_certificate";

const RULES: Array<[RegExp, SuggestedDocument]> = [
  [/resume|résumé|\bcv\b|curriculum vitae|bio-?data|बायोडाटा/i, "resume"],
  [/signature|हस्ताक्षर/i, "signature"],
  [/photo(graph)?|picture|passport size|फोटो/i, "photograph"],
  [/aadhaa?r|आधार/i, "aadhaar"],
  [/\bpan\b|pan card/i, "pan"],
  [/10th|class 10|matric|high school|sslc/i, "class_10_marksheet"],
  [/12th|class 12|intermediate|higher secondary|hsc/i, "class_12_marksheet"],
  [/degree certificate|provisional/i, "degree"],
  [/graduation|bachelor|marksheet|mark sheet/i, "graduation_marksheet"],
  [/caste|category certificate|जाति/i, "caste_certificate"],
  [/experience (letter|certificate)|relieving/i, "experience_certificate"],
];

export function suggestDocumentType(label: string): SuggestedDocument | null {
  for (const [re, type] of RULES) if (re.test(label)) return type;
  return null;
}

/** Does a file (name + MIME type) satisfy an <input accept="…"> list? Empty accept = anything. */
export function acceptsFile(accept: string | null, fileName: string, mime: string): boolean {
  const parts = (accept ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return true;
  const name = fileName.toLowerCase();
  const type = mime.toLowerCase();
  return parts.some((p) => (p.startsWith(".") ? name.endsWith(p) : p.endsWith("/*") ? type.startsWith(p.slice(0, -1)) : type === p));
}
