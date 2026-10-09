import { normalizeText } from "./language";

export type ChatIntent = "UPDATE" | "QUERY" | "SUMMARY" | "HELP" | "UNKNOWN";

const QUESTION = /\?$|^(what|whats|what's|which|when|where|who|tell|show|do\s+you\s+know|kya|kaun|kab|kahan|batao|bataiye|bataye|bata)\b|\b(kya\s+hai|kya\s+h|kya\s+he|batao|bataiye)\b|(क्या|कौन|कब|बताओ|बताइए|बताएं)/i;
const SUMMARY = /\b(about\s+me|know\s+about\s+me|my\s+(?:profile|details|information|info)|everything\s+you\s+know|mere\s+(?:baare|bare)\s+(?:mein|me|mai)|meri\s+(?:details|jankari|profile))\b|मेरे\s+बारे\s+में|मेरी\s+जानकारी/i;
const HELP = /^(hi|hii+|hello|hey|namaste|namaskar|hola|help|madad|start)\b|\b(what\s+can\s+you\s+do|how\s+(?:does\s+this|do\s+i\s+use)|kya\s+kar\s+sakte)\b|^(नमस्ते|नमस्कार|मदद)/i;

/** Which profile fields a question refers to. Order matters: more specific phrases first. */
const QUERY_FIELDS: Array<[RegExp, string]> = [
  [/\b(father|dad|papa|pita|pitaji)\b|पिता|पापा/i, "family.father_name"],
  [/\b(mother|mom|mummy|maa|mata)\b|माता|माँ|मां/i, "family.mother_name"],
  [/\b(wife|husband|spouse|pati|patni)\b|पति|पत्नी/i, "family.spouse_name"],
  [/\b(dob|date\s+of\s+birth|birthday|birth\s*date|born|janam|janm)\b|जन्म/i, "personal.date_of_birth"],
  [/\b(alternate|alternative)\s+(mobile|phone|number)\b/i, "contact.alternate_mobile"],
  [/\b(mobile|phone|contact\s+number|number)\b|मोबाइल|फोन/i, "contact.mobile"],
  [/\b(e-?mail)\b|ईमेल/i, "contact.email"],
  [/\b(pin\s*code|pincode|postal\s+code)\b|पिन/i, "contact.pincode"],
  [/\b(address|pata)\b|पता/i, "contact.address_line_1"],
  [/\b(state|rajya)\b|राज्य/i, "contact.state"],
  [/\b(city|town|village|shahar|gaon)\b|शहर/i, "contact.city"],
  [/\b(gender|sex|ling)\b|लिंग/i, "personal.gender"],
  [/\b(marital|married|shaadi|shadi)\b|वैवाहिक|शादी/i, "personal.marital_status"],
  [/\b(category|caste)\b|श्रेणी|वर्ग|जाति/i, "recruitment.category"],
  [/\bex[-\s]?service\s*man\b/i, "recruitment.ex_serviceman"],
  [/\b(pan)\b|पैन/i, "identity.pan_number"],
  [/\b(aadhaar|aadhar|adhar)\b|आधार/i, "identity.aadhaar_number"],
  [/\b(experience|anubhav)\b|अनुभव/i, "employment.experience_years"],
  [/\b(company|employer|office)\b|कंपनी/i, "employment.company"],
  [/\b(designation|job\s+title|post)\b|पद/i, "employment.designation"],
  [/\b(10th|tenth|class\s*10|matric|high\s*school)\b/i, "education.class_10.percentage"],
  [/\b(12th|twelfth|class\s*12|intermediate)\b/i, "education.class_12.percentage"],
  [/\b(qualification|education|degree|padhai)\b|योग्यता|शिक्षा/i, "education.highest_qualification"],
  [/\b(my\s+name|mera\s+naam|full\s+name)\b|मेरा\s+नाम/i, "personal.full_name"],
];

export function detectQueryFields(text: string): string[] {
  const t = normalizeText(text);
  const out: string[] = [];
  for (const [re, key] of QUERY_FIELDS) {
    if (re.test(t) && !out.includes(key)) {
      // "alternate mobile" must not also report the primary mobile.
      if (key === "contact.mobile" && out.includes("contact.alternate_mobile")) continue;
      out.push(key);
    }
  }
  return out;
}

/** Intent when no facts were extracted (facts always win: "My father's name is X?" is still an update). */
export function detectIntent(text: string, factsFound: boolean): ChatIntent {
  if (factsFound) return "UPDATE";
  const t = normalizeText(text);
  if (SUMMARY.test(t)) return "SUMMARY";
  if (QUESTION.test(t) && detectQueryFields(t).length > 0) return "QUERY";
  if (HELP.test(t)) return "HELP";
  return "UNKNOWN";
}
