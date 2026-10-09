import { findState, verhoeffValid, type DocumentType } from "@ufa/shared";
import { educationLevelFor } from "../targets";
import type { ExtractedCandidate } from "./types";

/**
 * Deterministic, explainable extractors over OCR/PDF text. They run first
 * (cheap, offline, predictable); local AI only supplements them.
 * Confidence values are deliberately conservative — every value still goes to
 * the user for confirmation.
 */

type Out = ExtractedCandidate[];
const rule = (fieldKey: string, value: string | null | undefined, confidence: number): ExtractedCandidate | null =>
  value && value.trim() ? { fieldKey, value: value.trim(), confidence, method: "rules" } : null;

export function toLines(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/\r?\n/)
    .map((l) => l.replace(/[|¦]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const DATE_RE = /(?<!\d)(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4})(?!\d)/;
const SEP_RE = /^[\s:：\-–—./]+/;

/** Value after a label on the same line ("Roll No: 123") or, if empty, the next line. */
export function labelValue(lines: string[], label: RegExp, opts: { maxLen?: number; exclude?: RegExp } = {}): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (opts.exclude?.test(line)) continue;
    const m = label.exec(line);
    if (!m) continue;
    let rest = line.slice(m.index + m[0].length).replace(SEP_RE, "").trim();
    // Bilingual labels: "पिता का नाम / Father's Name" — strip the repeated label.
    for (let again = label.exec(rest); again && again.index === 0; again = label.exec(rest)) {
      rest = rest.slice(again[0].length).replace(SEP_RE, "").trim();
    }
    if (!rest && lines[i + 1] && !label.test(lines[i + 1]!)) rest = lines[i + 1]!.trim();
    if (rest) return rest.slice(0, opts.maxLen ?? 120);
  }
  return null;
}

function dateNear(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i]!)) continue;
    const m = DATE_RE.exec(lines[i]!) ?? DATE_RE.exec(lines[i + 1] ?? "");
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  }
  return null;
}

/** Strips trailing noise from an OCR'd name and rejects things that are clearly not names. */
export function cleanName(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/^(shri|smt|kumari|km|mr|mrs|ms|miss|kum)\.?\s+/i, "")
    .replace(/[,;].*$/, "")
    .replace(/\s+(s\/o|d\/o|w\/o|c\/o|son of|daughter of|wife of)\b.*$/i, "")
    .replace(/[^\p{L}\p{M} .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = v.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 6 || v.length < 3) return null;
  if (/\b(government|india|department|board|university|certificate|date|birth|male|female|address|signature)\b/i.test(v)) return null;
  return v;
}

function lastPincode(text: string): string | null {
  const all = [...text.matchAll(/(?<!\d)([1-9]\d{5})(?!\d)/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

/** "This is to certify that Shri RAJ KUMAR son of Shri MOHAN LAL ..." */
function certifyPattern(text: string): { name: string | null; father: string | null } {
  const flat = text.replace(/\s+/g, " ");
  const m = /certif(?:y|ied) that\s+(?:shri|smt|kumari|km|mr|mrs|ms|sri|sh)?\.?\s*([A-Za-z .']{3,60}?)\s*,?\s*(?:s\/o|d\/o|son of|daughter of|son\/daughter of)\s+(?:shri|sri|sh|late)?\.?\s*([A-Za-z .']{3,60}?)(?:\s*,|\s+(?:resident|r\/o|of|is|has|belongs|aged|born|whose|bearing|in|with|who)\b)/i.exec(flat);
  return m ? { name: cleanName(m[1]!), father: cleanName(m[2]!) } : { name: null, father: null };
}

function aadhaar(text: string, lines: string[]): Out {
  const out: Array<ExtractedCandidate | null> = [];
  for (const m of text.matchAll(/(?<!\d)([2-9]\d{3})\s?(\d{4})\s?(\d{4})(?!\d)/g)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    if (verhoeffValid(digits)) {
      out.push(rule("identity.aadhaar_number", digits, 0.95));
      break;
    }
  }
  const dobLabel = /\b(DOB|D\.O\.B|Date of Birth)\b|जन्म\s*(तिथि|तारीख)/i;
  out.push(rule("personal.date_of_birth", dateNear(lines, dobLabel), 0.9));

  if (/\bFEMALE\b|महिला/i.test(text)) out.push(rule("personal.gender", "Female", 0.85));
  else if (/\bMALE\b|पुरुष/i.test(text)) out.push(rule("personal.gender", "Male", 0.85));
  else if (/\bTRANSGENDER\b/i.test(text)) out.push(rule("personal.gender", "Transgender", 0.85));

  // Name is printed (in English) a line or two above the DOB line.
  const dobIdx = lines.findIndex((l) => dobLabel.test(l));
  for (let i = dobIdx - 1; i >= Math.max(0, dobIdx - 3); i--) {
    const l = lines[i]!;
    if (/^[A-Za-z][A-Za-z .']{2,60}$/.test(l) && l.split(" ").length <= 5) {
      out.push(rule("personal.full_name", cleanName(l), 0.6));
      break;
    }
  }

  const rel = /\b(S\/O|D\/O|W\/O|C\/O|Son of|Daughter of|Wife of)\s*[:,]?\s*([A-Za-z .']{3,60})/i.exec(text);
  if (rel) {
    const kind = rel[1]!.toUpperCase();
    const name = cleanName(rel[2]!);
    if (kind.startsWith("W")) out.push(rule("family.spouse_name", name, 0.7));
    else if (!kind.startsWith("C")) out.push(rule("family.father_name", name, 0.7)); // C/O is ambiguous: skip
  }

  if (/address|पता/i.test(text)) {
    out.push(rule("contact.pincode", lastPincode(text), 0.65));
    out.push(rule("contact.state", findState(text), 0.6));
  }
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

function pan(text: string, lines: string[]): Out {
  const out: Array<ExtractedCandidate | null> = [];
  const num = /\b([A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z])\b/.exec(text.toUpperCase());
  out.push(rule("identity.pan_number", num?.[1], 0.95));

  const father = labelValue(lines, /father'?s?\s*name|पिता का नाम/i);
  const name = labelValue(lines, /^(?:नाम\s*\/\s*)?name\b/i, { exclude: /father/i });
  out.push(rule("family.father_name", cleanName(father), 0.8));
  out.push(rule("personal.full_name", cleanName(name), 0.8));
  out.push(rule("personal.date_of_birth", dateNear(lines, /date of birth|जन्म की तारीख|\bDOB\b/i), 0.85));

  // Older PAN layout: no labels; name, father's name, DOB follow the department header.
  if (!name) {
    const h = lines.findIndex((l) => /INCOME\s*TAX\s*DEPARTMENT/i.test(l));
    if (h >= 0) {
      const names = lines.slice(h + 1, h + 5).filter((l) => !/GOVT|INDIA/i.test(l)).map(cleanName).filter(Boolean);
      out.push(rule("personal.full_name", names[0], 0.5));
      if (!father) out.push(rule("family.father_name", names[1], 0.45));
    }
    if (!out.some((c) => c?.fieldKey === "personal.date_of_birth")) {
      const d = DATE_RE.exec(text);
      if (d) out.push(rule("personal.date_of_birth", `${d[1]}/${d[2]}/${d[3]}`, 0.6));
    }
  }
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

function percentageFrom(text: string): { value: string; confidence: number } | null {
  const p = /(percentage|percent|%age|प्रतिशत)\s*(?:obtained)?\s*[:\-=]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?/i.exec(text);
  if (p && Number(p[2]) <= 100) return { value: p[2]!, confidence: 0.8 };
  const t = /(grand total|total marks(?: obtained)?|marks obtained|aggregate)[^0-9]{0,30}(\d{2,4})\s*(?:\/|out of|of)\s*(\d{2,4})/i.exec(text);
  if (t) {
    const got = Number(t[2]);
    const max = Number(t[3]);
    if (max > 0 && got <= max) return { value: String(Math.round((got / max) * 10000) / 100), confidence: 0.7 };
  }
  return null;
}

function passingYear(text: string): { value: string; confidence: number } | null {
  const y = /(examination|exam|session|year of passing|passing year|year)[^0-9\n]{0,40}((?:19|20)\d{2})/i.exec(text);
  if (y) return { value: y[2]!, confidence: 0.7 };
  const m = /\b(?:march|april|may|june|july|october|november|december|mar|apr|jun|jul|oct|nov|dec)[\s,-]*((?:19|20)\d{2})\b/i.exec(text);
  return m ? { value: m[1]!, confidence: 0.6 } : null;
}

function education(text: string, lines: string[], level: string): Out {
  const out: Array<ExtractedCandidate | null> = [];
  const base = `education.${level}`;
  const school = level === "class_10" || level === "class_12";

  const cert = certifyPattern(text);
  const name =
    cleanName(labelValue(lines, /name of (?:the )?(?:candidate|student)|candidate'?s name|student'?s? name|परीक्षार्थी का नाम/i)) ??
    cleanName(labelValue(lines, /^(?:नाम\s*\/\s*)?name\b/i, { exclude: /father|mother|school|college|board|university|institute/i })) ??
    cert.name;
  out.push(rule("personal.full_name", name, 0.75));
  out.push(rule("family.father_name", cleanName(labelValue(lines, /father'?s?(?:\s*\/\s*guardian'?s?)?\s*name|पिता का नाम/i)) ?? cert.father, 0.75));
  out.push(rule("family.mother_name", cleanName(labelValue(lines, /mother'?s?\s*name|माता का नाम/i)), 0.75));
  out.push(rule("personal.date_of_birth", dateNear(lines, /date of birth|\bDOB\b|जन्म\s*तिथि/i), 0.85));

  const roll = labelValue(lines, /roll\s*(?:no|number|code)\.?|अनुक्रमांक/i);
  out.push(rule(`${base}.roll_number`, roll?.match(/[A-Z0-9][A-Z0-9/-]{2,20}/i)?.[0], 0.8));

  const year = passingYear(text);
  if (year) out.push(rule(`${base}.passing_year`, year.value, year.confidence));
  const pct = percentageFrom(text);
  if (pct) out.push(rule(`${base}.percentage`, pct.value, pct.confidence));

  if (school) {
    const board = lines.find((l) => /central board of secondary education|council for the indian school certificate|board of (?:secondary|higher secondary|school|intermediate) education|shiksha parishad|माध्यमिक शिक्षा/i.test(l));
    out.push(rule(`${base}.board`, board?.slice(0, 100), 0.65));
    out.push(rule(`${base}.school`, cleanSchool(labelValue(lines, /school(?:\s*name)?\s*[:-]|name of (?:the )?school|विद्यालय/i)), 0.6));
    if (level === "class_12") {
      const stream = /\b(science|commerce|arts|humanities|vocational)\b/i.exec(text);
      out.push(rule(`${base}.stream`, stream ? stream[1]![0]!.toUpperCase() + stream[1]!.slice(1).toLowerCase() : null, 0.6));
    }
  } else {
    const cgpa = /\b(CGPA|C\.G\.P\.A\.?|CPI)\s*[:\-=]?\s*(\d{1,2}(?:\.\d{1,2})?)/i.exec(text);
    if (cgpa && Number(cgpa[2]) <= 10) out.push(rule(`${base}.cgpa`, cgpa[2], 0.8));
    out.push(rule(`${base}.registration_number`, labelValue(lines, /(?:registration|enrol?lment)\s*(?:no|number)\.?/i)?.match(/[A-Z0-9][A-Z0-9/-]{3,25}/i)?.[0], 0.75));
    out.push(rule(`${base}.university`, lines.find((l) => /university|vishwavidyalaya|विश्वविद्यालय/i.test(l))?.slice(0, 120), 0.65));
    out.push(rule(`${base}.college`, lines.find((l) => /\b(college|institute|mahavidyalaya)\b/i.test(l) && !/university/i.test(l))?.slice(0, 120), 0.55));
    const course = /\b(Bachelor|Master)\s+of\s+[A-Za-z ]{3,40}|\bB\.?\s?(?:Com|Sc|A|Tech|E|Ed|Pharm|C\.?A|B\.?A)\b\.?|\bM\.?\s?(?:Com|Sc|A|Tech|B\.?A|C\.?A)\b\.?|\bDiploma in [A-Za-z ]{3,40}/.exec(text);
    out.push(rule(`${base}.course`, course?.[0].replace(/\s+(in|with)\s*$/i, "").trim(), 0.6));
  }
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

function cleanSchool(v: string | null): string | null {
  return v ? v.replace(/[^\p{L}\p{M}\p{N} .,'()&-]/gu, "").trim().slice(0, 120) || null : null;
}

function certificates(type: DocumentType, text: string, lines: string[]): Out {
  const out: Array<ExtractedCandidate | null> = [];
  const cert = certifyPattern(text);
  out.push(rule("personal.full_name", cert.name, 0.65));
  out.push(rule("family.father_name", cert.father, 0.65));
  if (type === "caste_certificate") {
    const cat = /other backward class|\bO\.?B\.?C\b/i.test(text) ? "OBC" : /scheduled tribe|\bS\.?T\b/i.test(text) ? "ST" : /scheduled caste|\bS\.?C\b/i.test(text) ? "SC" : null;
    out.push(rule("recruitment.category", cat, 0.75));
    out.push(rule("recruitment.caste_certificate_number", labelValue(lines, /certificate\s*(?:no|number)\.?|प्रमाण\s*पत्र\s*(?:संख्या|क्रमांक)/i)?.match(/[A-Z0-9][A-Z0-9/-]{3,30}/i)?.[0], 0.7));
    const caste = /belongs? to (?:the )?([A-Za-z]{3,30}) (?:caste|community)/i.exec(text);
    out.push(rule("recruitment.caste", caste?.[1], 0.6));
  }
  if (type === "domicile_certificate") out.push(rule("recruitment.domicile_state", findState(text), 0.6));
  if (type === "ews_certificate" && /economically weaker section|\bEWS\b|आर्थिक रूप से कमजोर/i.test(text)) out.push(rule("recruitment.ews", "yes", 0.75));
  if (type === "disability_certificate" && /disabilit|divyang|दिव्यांग|handicap/i.test(text)) out.push(rule("recruitment.pwd", "yes", 0.7));
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

function employment(text: string, lines: string[]): Out {
  const out: Array<ExtractedCandidate | null> = [];
  out.push(rule("personal.full_name", cleanName(labelValue(lines, /employee\s*name|^name\b/i, { exclude: /company|father/i })), 0.7));
  out.push(rule("employment.designation", labelValue(lines, /designation|position\b/i, { maxLen: 60 }), 0.7));
  out.push(rule("employment.department", labelValue(lines, /department\b/i, { maxLen: 60 }), 0.7));
  out.push(rule("employment.employee_id", labelValue(lines, /(?:employee|emp\.?)\s*(?:id|code|no)\.?/i)?.match(/[A-Z0-9][A-Z0-9/-]{1,20}/i)?.[0], 0.75));
  out.push(rule("employment.joining_date", dateNear(lines, /date of joining|joining date|\bDOJ\b/i), 0.75));
  const company = lines.find((l) => /\b(pvt\.?\s*ltd|private limited|limited|llp|technologies|solutions|industries)\b/i.test(l));
  out.push(rule("employment.company", company?.replace(/[^\p{L}\p{M}\p{N} .,&()-]/gu, "").trim().slice(0, 100), 0.5));
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

function resume(text: string, lines: string[], raw: string): Out {
  const out: Array<ExtractedCandidate | null> = [];
  out.push(rule("contact.email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0], 0.85));
  out.push(rule("contact.mobile", /(?<!\d)(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/.exec(text)?.[0], 0.8));
  const first = lines.slice(0, 3).map(cleanName).find((n) => n && n.split(" ").length >= 2 && n.split(" ").length <= 4);
  out.push(rule("personal.full_name", first, 0.5));
  out.push(rule("personal.date_of_birth", dateNear(lines, /date of birth|\bDOB\b/i), 0.75));
  const linkedin = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}\/?/i.exec(text)?.[0];
  out.push(rule("employment.linkedin_url", linkedin ? (/^https?:/i.test(linkedin) ? linkedin : `https://${linkedin}`).replace(/\/$/, "") : null, 0.9));
  // Skills / summary: the lines under a CV heading, up to the next heading (always reviewed by the user).
  const skills = cvSection(lines, /^((key|technical|core) )?skills( set)?$|^core competencies$|^कौशल$/i)
    .flatMap((l) => l.replace(/^[•●▪*–-]\s*/, "").split(/\s*[,;•●▪]\s*/))
    .map((s) => s.replace(/^[^:]{2,30}:\s*/, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
  out.push(rule("employment.skills", [...new Set(skills)].join(", ").slice(0, 500), 0.6));
  const summary = cvSection(lines, /^((professional|profile|career) )?(summary|objective|profile)$|^about me$/i).join(" ");
  out.push(rule("employment.summary", summary.length >= 30 ? summary.slice(0, 500) : null, 0.55));
  // Experience / education lines use "|" as a separator, which toLines() removes: read the raw lines.
  const rawLines = raw.normalize("NFKC").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  out.push(...cvExperience(rawLines), ...cvEducation(rawLines));
  return out.filter((c): c is ExtractedCandidate => c !== null);
}

const MONTH_YEAR = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b\d{1,2}\/\d{4}\b|\b(19|20)\d{2}\b/i;

/** Latest job from "Title | Company, City  Mon YYYY – Present" (the common one-line CV format). */
function cvExperience(lines: string[]): Array<ExtractedCandidate | null> {
  const first = cvSection(lines, /^(work |professional )?experience$|^employment( history)?$|^work history$/i).find((l) => l.includes("|") && MONTH_YEAR.test(l));
  if (!first) return [];
  const [title, rest = ""] = first.split("|").map((s) => s.trim());
  const company = rest.split(MONTH_YEAR)[0]!.split(",")[0]!.trim();
  const current = /present|current|till date|now/i.test(rest);
  return [
    rule("employment.designation", title && title.length <= 80 ? title : null, 0.6),
    rule("employment.company", current && company.length >= 2 && company.length <= 100 ? company : null, 0.6),
  ];
}

const PG = /^(mba|pgdm|m\.?\s?com|m\.?\s?tech|m\.?\s?e\b|mca|m\.?\s?sc|m\.?\s?a\b|ma\b|msc|llm|m\.?\s?ed|master)/i;
const UG = /^(b\.?\s?com|b\.?\s?tech|b\.?\s?e\b|bca|bba|b\.?\s?sc|b\.?\s?a\b|ba\b|bsc|llb|b\.?\s?ed|bachelor)/i;

/** "MBA, Finance & HR | University, City | 2020 – 2022" lines under EDUCATION. */
function cvEducation(lines: string[]): Array<ExtractedCandidate | null> {
  const rows = cvSection(lines, /^education(al (details|qualifications?))?$|^academic (details|qualifications?)$|^qualifications?$/i).filter((l) => l.includes("|"));
  const out: Array<ExtractedCandidate | null> = [];
  let highest: string | null = null;
  for (const row of rows) {
    const [degreePart = "", uniPart = "", yearPart = ""] = row.split("|").map((s) => s.trim());
    const level = PG.test(degreePart) ? "post_graduation" : UG.test(degreePart) ? "graduation" : null;
    if (!level || out.some((c) => c?.fieldKey === `education.${level}.course`)) continue;
    highest ??= degreePart;
    const [course, ...spec] = degreePart.split(",").map((s) => s.trim());
    const years = [...`${yearPart} ${uniPart}`.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
    out.push(
      rule(`education.${level}.course`, course, 0.6),
      rule(`education.${level}.specialization`, spec.join(", ") || null, 0.55),
      rule(`education.${level}.university`, uniPart.split(",")[0]!.trim() || null, 0.55),
      rule(`education.${level}.passing_year`, years.at(-1) ?? null, 0.55),
    );
  }
  out.push(rule("education.highest_qualification", highest, 0.55));
  return out;
}

const CV_HEADING =
  /^((academic|educational) )?(education|qualifications?|experience|work experience|employment|projects?|skills|technical skills|key skills|certifications?|achievements|hobbies|interests|languages|personal (details|information)|declaration|summary|objective|profile|about me|contact|references|internships?|strengths)$/i;

/** Lines under the heading matching `start` (text after "Heading:" counts), until the next CV heading; at most 8 lines. */
function cvSection(lines: string[], start: RegExp): string[] {
  const head = (l: string) => l.split(":")[0]!.trim();
  const i = lines.findIndex((l) => start.test(head(l)));
  if (i < 0) return [];
  const line = lines[i]!;
  const sameLine = line.includes(":") ? line.slice(line.indexOf(":") + 1).trim() : "";
  const out = sameLine ? [sameLine] : [];
  for (const l of lines.slice(i + 1, i + 9)) {
    if (CV_HEADING.test(head(l))) break;
    out.push(l);
  }
  return out;
}

export function extractWithRules(type: DocumentType, text: string): ExtractedCandidate[] {
  const lines = toLines(text);
  const flat = lines.join("\n");
  const level = educationLevelFor(type);
  if (level) return education(flat, lines, level);
  switch (type) {
    case "aadhaar":
      return aadhaar(flat, lines);
    case "pan":
      return pan(flat, lines);
    case "caste_certificate":
    case "domicile_certificate":
    case "ews_certificate":
    case "disability_certificate":
      return certificates(type, flat, lines);
    case "experience_certificate":
    case "salary_slip":
      return employment(flat, lines);
    case "resume":
      return resume(flat, lines, text);
    default:
      return [];
  }
}
