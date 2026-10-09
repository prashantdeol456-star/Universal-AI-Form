import type { NormalizedField } from "@ufa/form-engine";
import { conceptsOf, levelOf, type Concept } from "./lexicon";
import type { Evidence } from "./types";

/**
 * Deterministic rules (spec §27 step 1): HTML autocomplete tokens and concept
 * rules over the label, with the section heading as context. Each hit is evidence
 * for a profile field; the confidence engine weighs everything together.
 */
export interface RuleHit {
  fieldKey: string;
  evidence: Evidence;
}

const AUTOCOMPLETE: Record<string, string> = {
  name: "personal.full_name",
  "given-name": "personal.first_name",
  "additional-name": "personal.middle_name",
  "family-name": "personal.last_name",
  email: "contact.email",
  tel: "contact.mobile",
  "tel-national": "contact.mobile",
  mobile: "contact.mobile",
  bday: "personal.date_of_birth",
  sex: "personal.gender",
  "postal-code": "contact.pincode",
  "address-line1": "contact.address_line_1",
  "street-address": "contact.address_line_1",
  "address-line2": "contact.address_line_2",
  "address-level2": "contact.city",
  "address-level1": "contact.state",
  "country-name": "contact.country",
  country: "contact.country",
  organization: "employment.company",
  "organization-title": "employment.designation",
};

type Level = "class_10" | "class_12" | "graduation" | "post_graduation" | "diploma";
const ALL_LEVELS: Level[] = ["class_10", "class_12", "graduation", "post_graduation", "diploma"];

interface Rule {
  all: Concept[];
  none?: Concept[];
  key: string;
  weight: number;
  /** The label can genuinely mean more than one field: always needs the user's review. */
  ambiguous?: true;
}

export const AMBIGUOUS_MARK = "ambiguous:";

/** Ordered from specific to generic. Several rules may fire; weights decide. */
const RULES: Rule[] = [
  // Family names
  { all: ["FATHER", "NAME"], none: ["GUARDIAN", "HUSBAND", "WIFE", "SPOUSE"], key: "family.father_name", weight: 0.88 },
  { all: ["FATHER"], none: ["GUARDIAN", "NAME", "OCCUPATION", "INCOME"], key: "family.father_name", weight: 0.72 },
  { all: ["MOTHER", "NAME"], key: "family.mother_name", weight: 0.88 },
  { all: ["MOTHER"], none: ["NAME", "MOTHER_TONGUE", "OCCUPATION", "INCOME"], key: "family.mother_name", weight: 0.72 },
  { all: ["GUARDIAN", "NAME"], none: ["FATHER"], key: "family.guardian_name", weight: 0.85 },
  { all: ["GUARDIAN"], none: ["FATHER"], key: "family.guardian_name", weight: 0.65 },
  // "Father / Guardian Name": genuinely ambiguous -> two weaker candidates.
  { all: ["FATHER", "GUARDIAN"], key: "family.father_name", weight: 0.6, ambiguous: true },
  { all: ["FATHER", "GUARDIAN"], key: "family.guardian_name", weight: 0.5, ambiguous: true },
  // "Father's / Husband's Name" (common for married women): also ambiguous.
  { all: ["FATHER", "HUSBAND"], key: "family.father_name", weight: 0.6, ambiguous: true },
  { all: ["FATHER", "HUSBAND"], key: "family.spouse_name", weight: 0.5, ambiguous: true },
  { all: ["SPOUSE"], key: "family.spouse_name", weight: 0.85 },
  { all: ["HUSBAND", "NAME"], none: ["FATHER"], key: "family.spouse_name", weight: 0.85 },
  { all: ["WIFE", "NAME"], key: "family.spouse_name", weight: 0.85 },
  // Own name
  { all: ["FIRST", "NAME"], key: "personal.first_name", weight: 0.9 },
  { all: ["MIDDLE", "NAME"], key: "personal.middle_name", weight: 0.9 },
  { all: ["LAST", "NAME"], none: ["FATHER", "MOTHER"], key: "personal.last_name", weight: 0.9 },
  { all: ["FULL", "NAME"], none: ["FATHER", "MOTHER", "GUARDIAN", "SPOUSE", "HUSBAND", "WIFE", "BANK"], key: "personal.full_name", weight: 0.88 },
  { all: ["CANDIDATE", "NAME"], none: ["FATHER", "MOTHER", "GUARDIAN", "SPOUSE", "HUSBAND", "WIFE"], key: "personal.full_name", weight: 0.88 },
  { all: ["NAME", "AS_PER"], none: ["FATHER", "MOTHER", "GUARDIAN"], key: "personal.full_name", weight: 0.82 },
  // Personal
  { all: ["DATE", "BIRTH"], key: "personal.date_of_birth", weight: 0.92 },
  { all: ["BIRTH"], none: ["PLACE"], key: "personal.date_of_birth", weight: 0.7 },
  { all: ["GENDER"], key: "personal.gender", weight: 0.92 },
  { all: ["MARITAL"], key: "personal.marital_status", weight: 0.92 },
  { all: ["NATIONALITY"], key: "personal.nationality", weight: 0.9 },
  { all: ["RELIGION"], key: "personal.religion", weight: 0.9 },
  { all: ["MOTHER_TONGUE"], key: "personal.mother_tongue", weight: 0.9 },
  // Contact
  { all: ["ALTERNATE", "MOBILE"], key: "contact.alternate_mobile", weight: 0.9 },
  { all: ["ALTERNATE", "PHONE"], key: "contact.alternate_mobile", weight: 0.85 },
  { all: ["MOBILE"], none: ["ALTERNATE"], key: "contact.mobile", weight: 0.9 },
  { all: ["PHONE"], none: ["ALTERNATE"], key: "contact.mobile", weight: 0.75 },
  { all: ["EMAIL"], key: "contact.email", weight: 0.93 },
  { all: ["ADDRESS", "LINE2"], key: "contact.address_line_2", weight: 0.9 },
  { all: ["ADDRESS"], none: ["LINE2", "EMAIL", "CURRENT"], key: "contact.address_line_1", weight: 0.8 },
  { all: ["ADDRESS", "CURRENT"], key: "contact.address_line_1", weight: 0.55 },
  { all: ["PIN"], key: "contact.pincode", weight: 0.92 },
  { all: ["DISTRICT"], key: "contact.district", weight: 0.9 },
  { all: ["CITY"], key: "contact.city", weight: 0.85 },
  { all: ["STATE"], none: ["DOMICILE"], key: "contact.state", weight: 0.82 },
  { all: ["COUNTRY"], key: "contact.country", weight: 0.88 },
  // Recruitment
  { all: ["CATEGORY"], none: ["CERTIFICATE"], key: "recruitment.category", weight: 0.88 },
  { all: ["CASTE", "CERTIFICATE", "NUMBER"], key: "recruitment.caste_certificate_number", weight: 0.9 },
  { all: ["CASTE"], none: ["CERTIFICATE", "CATEGORY"], key: "recruitment.caste", weight: 0.75 },
  { all: ["EXSERVICEMAN"], key: "recruitment.ex_serviceman", weight: 0.93 },
  { all: ["PWD"], none: ["CERTIFICATE"], key: "recruitment.pwd", weight: 0.9 },
  { all: ["EWS"], none: ["CERTIFICATE"], key: "recruitment.ews", weight: 0.88 },
  { all: ["GOVERNMENT", "EMPLOYEE"], key: "recruitment.government_employee", weight: 0.9 },
  { all: ["DOMICILE"], key: "recruitment.domicile_state", weight: 0.85 },
  // Identity
  { all: ["AADHAAR"], key: "identity.aadhaar_number", weight: 0.93 },
  { all: ["PAN"], key: "identity.pan_number", weight: 0.93 },
  { all: ["PASSPORT"], key: "identity.passport_number", weight: 0.92 },
  { all: ["VOTER"], key: "identity.voter_id", weight: 0.92 },
  { all: ["DRIVING", "LICENCE"], key: "identity.driving_license_number", weight: 0.92 },
  // Bank
  { all: ["IFSC"], key: "bank.ifsc", weight: 0.94 },
  { all: ["ACCOUNT", "NUMBER"], none: ["EMPLOYEE"], key: "bank.account_number", weight: 0.85 },
  { all: ["BANK", "NAME"], key: "bank.bank_name", weight: 0.9 },
  { all: ["BRANCH"], key: "bank.branch", weight: 0.85 },
  // Employment
  { all: ["EXPERIENCE"], key: "employment.experience_years", weight: 0.85 },
  { all: ["COMPANY"], key: "employment.company", weight: 0.82 },
  { all: ["DESIGNATION"], key: "employment.designation", weight: 0.82 },
  { all: ["DEPARTMENT"], key: "employment.department", weight: 0.8 },
  { all: ["SALARY", "DESIRED"], key: "employment.desired_salary", weight: 0.88 },
  { all: ["SALARY"], none: ["DESIRED"], key: "employment.salary", weight: 0.85 },
  { all: ["LINKEDIN"], key: "employment.linkedin_url", weight: 0.9 },
  { all: ["RELOCATE"], key: "employment.willing_to_relocate", weight: 0.88 },
  { all: ["SPONSORSHIP"], key: "employment.needs_visa_sponsorship", weight: 0.88 },
  { all: ["WORK_AUTH"], key: "employment.authorized_to_work", weight: 0.85 },
  { all: ["TRAVEL"], key: "employment.willing_to_travel", weight: 0.8 },
  { all: ["START", "DATE"], key: "employment.earliest_start_date", weight: 0.85 },
  { all: ["JOINING"], key: "employment.joining_date", weight: 0.85 },
  { all: ["NOTICE"], key: "employment.notice_period", weight: 0.88 },
  { all: ["EMPLOYEE", "NUMBER"], none: ["GOVERNMENT"], key: "employment.employee_id", weight: 0.8 },
  // Education (level-independent)
  { all: ["HIGHEST", "QUALIFICATION"], key: "education.highest_qualification", weight: 0.92 },
  { all: ["QUALIFICATION"], none: ["HIGHEST", "YEAR", "PERCENTAGE", "ROLL"], key: "education.highest_qualification", weight: 0.6 },
];

/** Education sub-fields that need a level (class_10, graduation, …). */
const EDU_FIELDS: Array<{ all: Concept[]; none?: Concept[]; sub: string; weight: number; levels?: Level[] }> = [
  { all: ["YEAR", "PASSING"], sub: "passing_year", weight: 0.9 },
  { all: ["YEAR"], none: ["EXPERIENCE", "BIRTH", "PASSING"], sub: "passing_year", weight: 0.6 },
  { all: ["PERCENTAGE"], sub: "percentage", weight: 0.88 },
  { all: ["CGPA"], sub: "cgpa", weight: 0.88, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["ROLL"], sub: "roll_number", weight: 0.88 },
  { all: ["REGISTRATION"], sub: "registration_number", weight: 0.85, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["BOARD"], sub: "board", weight: 0.88, levels: ["class_10", "class_12"] },
  { all: ["SCHOOL"], none: ["BOARD"], sub: "school", weight: 0.8, levels: ["class_10", "class_12"] },
  { all: ["UNIVERSITY"], sub: "university", weight: 0.88, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["COLLEGE"], none: ["UNIVERSITY"], sub: "college", weight: 0.82, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["COURSE"], sub: "course", weight: 0.8, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["SPECIALIZATION"], sub: "specialization", weight: 0.78, levels: ["graduation", "post_graduation", "diploma"] },
  { all: ["STREAM"], sub: "stream", weight: 0.8, levels: ["class_12"] },
];

const has = (s: Set<Concept>, all: Concept[], none: Concept[] = []) => all.every((c) => s.has(c)) && !none.some((c) => s.has(c));

/** Concepts that mean "this is not a profile value at all". */
export function nonProfileReason(field: Pick<NormalizedField, "label" | "kind" | "options">): "declaration" | "captcha" | "otp" | "password" | "upload" | null {
  const c = conceptsOf(field.label).concepts;
  if (field.kind === "file" || c.has("UPLOAD")) return "upload";
  if (field.kind === "password" || c.has("PASSWORD")) return "password";
  if (c.has("CAPTCHA")) return "captcha";
  if (c.has("OTP")) return "otp";
  if (field.kind === "checkbox" && field.options.length <= 1 && c.has("DECLARATION")) return "declaration";
  return null;
}

export function ruleHits(field: NormalizedField): RuleHit[] {
  const hits: RuleHit[] = [];

  const ac = field.autocomplete?.toLowerCase().split(/\s+/).pop();
  if (ac && AUTOCOMPLETE[ac]) hits.push({ fieldKey: AUTOCOMPLETE[ac]!, evidence: { source: "autocomplete", weight: 0.85, detail: `autocomplete=${ac}` } });

  const label = conceptsOf(field.label);
  const section = conceptsOf(field.section ?? "");
  const c = label.concepts;

  for (const r of RULES) {
    if (has(c, r.all, r.none)) hits.push({ fieldKey: r.key, evidence: { source: "lexicon", weight: r.weight, detail: `${r.ambiguous ? AMBIGUOUS_MARK : ""}${r.all.join("+")}` } });
  }

  // A bare "Name" (nothing else in the label) takes its meaning from the section:
  // "Guardian Details > Name" is the guardian's name; "Personal Details > Name" is the applicant's.
  if (c.has("NAME") && c.size <= 2 && label.unknownTokens.length === 0 && !hits.some((h) => h.fieldKey.includes("name") && h.evidence.weight >= 0.8)) {
    const sc = section.concepts;
    const key = sc.has("GUARDIAN") ? "family.guardian_name" : sc.has("FATHER") ? "family.father_name" : sc.has("MOTHER") ? "family.mother_name" : sc.has("BANK") ? "bank.bank_name" : "personal.full_name";
    const weight = key !== "personal.full_name" || sc.has("CANDIDATE") ? 0.8 : 0.72; // no context: suggest, never auto-fill
    hits.push({ fieldKey: key, evidence: { source: "lexicon", weight, detail: `NAME in section "${field.section ?? ""}"` } });
  }

  // Exact-label factor (spec §28): every word of the label was understood and a strong
  // rule fired — "Father's Name", "पिता का नाम" — as opposed to a label with unknown words.
  if (label.unknownTokens.length === 0) {
    for (const h of [...hits]) {
      if (h.evidence.source === "lexicon" && h.evidence.weight >= 0.85) {
        hits.push({ fieldKey: h.fieldKey, evidence: { source: "lexicon", weight: 0.5, detail: "every word of the label recognised" } });
      }
    }
  }

  // Education: field type from the label, level from the label, else from the section.
  const eduField = EDU_FIELDS.find((e) => has(c, e.all, e.none));
  if (eduField && !c.has("HIGHEST")) {
    const level = levelOf(c) ?? levelOf(section.concepts);
    const levels = (level ? [level] : (eduField.levels ?? ALL_LEVELS)).filter((l) => !eduField.levels || eduField.levels.includes(l));
    for (const l of levels) {
      const key = `education.${l}.${eduField.sub}`;
      const weight = level ? eduField.weight : Math.min(eduField.weight, 0.45);
      hits.push({ fieldKey: key, evidence: { source: "lexicon", weight, detail: level ? `${eduField.sub} + ${l}` : `${eduField.sub}, level unknown` } });
    }
  }

  // Radio/select questions: "Are you an Ex-Serviceman?" etc. are already covered above;
  // input types add a little supporting evidence.
  const typeHint: Record<string, string> = { email: "contact.email", tel: "contact.mobile", date: "personal.date_of_birth" };
  const th = typeHint[field.kind];
  if (th && hits.some((h) => h.fieldKey === th)) hits.push({ fieldKey: th, evidence: { source: "input_type", weight: 0.3, detail: `type=${field.kind}` } });

  return hits;
}
