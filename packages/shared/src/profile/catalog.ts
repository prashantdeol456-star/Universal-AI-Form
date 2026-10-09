import type { ValidatorName } from "../validation/validators";

/**
 * The canonical profile field catalog. Field keys are `<category>.<name>` (or
 * `<category>.<group>.<name>` for repeated education levels) and are the stable
 * identifiers that form mappings, learning examples and AI outputs refer to.
 *
 * Labels carry English and Hindi so the UI and (later) the mapping engine can
 * reason about multilingual forms. `aliases` seed deterministic matching in Phase 5.
 */
export const PROFILE_CATEGORIES = [
  "personal",
  "contact",
  "family",
  "identity",
  "education",
  "employment",
  "recruitment",
  "bank",
  "custom",
] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ProfileCategory, { en: string; hi: string }> = {
  personal: { en: "Personal", hi: "व्यक्तिगत" },
  contact: { en: "Contact & Address", hi: "संपर्क एवं पता" },
  family: { en: "Family", hi: "परिवार" },
  identity: { en: "Identity", hi: "पहचान" },
  education: { en: "Education", hi: "शिक्षा" },
  employment: { en: "Employment", hi: "रोज़गार" },
  recruitment: { en: "Government / Recruitment", hi: "सरकारी / भर्ती" },
  bank: { en: "Bank", hi: "बैंक" },
  custom: { en: "Custom Fields", hi: "अन्य जानकारी" },
};

export type FieldInputType = "text" | "date" | "number" | "select" | "yes_no" | "textarea";

/**
 * Sensitivity levels:
 *  - normal: stored in plaintext, visible to café sessions with the category permission
 *  - sensitive: encrypted at rest, masked in UI by default
 *  - restricted: encrypted at rest, masked, and never exposed to café operators (bank)
 */
export type Sensitivity = "normal" | "sensitive" | "restricted";

export interface ProfileFieldDef {
  key: string;
  category: ProfileCategory;
  label: { en: string; hi: string };
  input: FieldInputType;
  validator: ValidatorName;
  options?: readonly string[];
  sensitivity: Sensitivity;
  /** Counts toward profile-completion % */
  core?: boolean;
  aliases?: readonly string[];
  group?: string;
}

const GENDERS = ["Male", "Female", "Transgender", "Other"] as const;
const MARITAL = ["Unmarried", "Married", "Divorced", "Widowed", "Separated"] as const;
const CATEGORIES = ["General", "OBC", "SC", "ST", "EWS"] as const;

function f(def: Omit<ProfileFieldDef, "sensitivity"> & { sensitivity?: Sensitivity }): ProfileFieldDef {
  return { sensitivity: "normal", ...def };
}

const EDUCATION_LEVELS = [
  { id: "class_10", en: "Class 10", hi: "कक्षा 10" },
  { id: "class_12", en: "Class 12", hi: "कक्षा 12" },
  { id: "diploma", en: "Diploma", hi: "डिप्लोमा" },
  { id: "graduation", en: "Graduation", hi: "स्नातक" },
  { id: "post_graduation", en: "Post Graduation", hi: "स्नातकोत्तर" },
] as const;

function educationFields(): ProfileFieldDef[] {
  const out: ProfileFieldDef[] = [];
  for (const lvl of EDUCATION_LEVELS) {
    const school = lvl.id === "class_10" || lvl.id === "class_12";
    const base = `education.${lvl.id}`;
    const push = (name: string, en: string, hi: string, input: FieldInputType, validator: ValidatorName, core = false) =>
      out.push(f({ key: `${base}.${name}`, category: "education", group: lvl.id, label: { en: `${lvl.en} — ${en}`, hi: `${lvl.hi} — ${hi}` }, input, validator, core }));

    if (school) {
      push("board", "Board", "बोर्ड", "text", "text", lvl.id === "class_10");
      push("school", "School", "विद्यालय", "text", "text");
      if (lvl.id === "class_12") push("stream", "Stream", "संकाय", "text", "text");
    } else {
      push("course", "Course / Degree", "पाठ्यक्रम / डिग्री", "text", "text", lvl.id === "graduation");
      push("specialization", "Specialization", "विशेषज्ञता", "text", "text");
      push("university", "University / Board", "विश्वविद्यालय", "text", "text");
      push("college", "College / Institute", "महाविद्यालय", "text", "text");
      push("cgpa", "CGPA", "सीजीपीए", "number", "cgpa");
      push("registration_number", "Registration Number", "पंजीकरण संख्या", "text", "text");
    }
    push("passing_year", "Year of Passing", "उत्तीर्ण वर्ष", "number", "year", lvl.id === "class_10");
    push("percentage", "Percentage", "प्रतिशत", "number", "percentage", lvl.id === "class_10");
    push("roll_number", "Roll Number", "अनुक्रमांक", "text", "text");
  }
  return out;
}

export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  // Personal
  f({ key: "personal.full_name", category: "personal", label: { en: "Full Name", hi: "पूरा नाम" }, input: "text", validator: "person_name", core: true,
      aliases: ["candidate name", "applicant name", "name of candidate", "name as per matriculation", "उम्मीदवार का नाम", "आवेदक का नाम", "नाम"] }),
  f({ key: "personal.first_name", category: "personal", label: { en: "First Name", hi: "पहला नाम" }, input: "text", validator: "person_name" }),
  f({ key: "personal.middle_name", category: "personal", label: { en: "Middle Name", hi: "मध्य नाम" }, input: "text", validator: "person_name" }),
  f({ key: "personal.last_name", category: "personal", label: { en: "Last Name", hi: "उपनाम" }, input: "text", validator: "person_name", aliases: ["surname"] }),
  f({ key: "personal.date_of_birth", category: "personal", label: { en: "Date of Birth", hi: "जन्म तिथि" }, input: "date", validator: "past_date", core: true, aliases: ["dob", "birth date", "जन्मतिथि"] }),
  f({ key: "personal.gender", category: "personal", label: { en: "Gender", hi: "लिंग" }, input: "select", validator: "select", options: GENDERS, core: true }),
  f({ key: "personal.nationality", category: "personal", label: { en: "Nationality", hi: "राष्ट्रीयता" }, input: "text", validator: "text", core: true }),
  f({ key: "personal.marital_status", category: "personal", label: { en: "Marital Status", hi: "वैवाहिक स्थिति" }, input: "select", validator: "select", options: MARITAL, core: true }),
  f({ key: "personal.religion", category: "personal", label: { en: "Religion", hi: "धर्म" }, input: "text", validator: "text" }),
  f({ key: "personal.mother_tongue", category: "personal", label: { en: "Mother Tongue", hi: "मातृभाषा" }, input: "text", validator: "text" }),

  // Contact
  f({ key: "contact.mobile", category: "contact", label: { en: "Mobile Number", hi: "मोबाइल नंबर" }, input: "text", validator: "mobile_in", core: true, aliases: ["phone", "mobile no", "contact number"] }),
  f({ key: "contact.alternate_mobile", category: "contact", label: { en: "Alternate Mobile", hi: "वैकल्पिक मोबाइल" }, input: "text", validator: "mobile_in" }),
  f({ key: "contact.email", category: "contact", label: { en: "Email", hi: "ईमेल" }, input: "text", validator: "email", core: true }),
  f({ key: "contact.address_line_1", category: "contact", label: { en: "Address Line 1", hi: "पता पंक्ति 1" }, input: "text", validator: "text", core: true, aliases: ["permanent address", "स्थायी पता"] }),
  f({ key: "contact.address_line_2", category: "contact", label: { en: "Address Line 2", hi: "पता पंक्ति 2" }, input: "text", validator: "text" }),
  f({ key: "contact.city", category: "contact", label: { en: "City / Town / Village", hi: "शहर / कस्बा / गाँव" }, input: "text", validator: "text", core: true }),
  f({ key: "contact.district", category: "contact", label: { en: "District", hi: "ज़िला" }, input: "text", validator: "text", core: true }),
  f({ key: "contact.state", category: "contact", label: { en: "State", hi: "राज्य" }, input: "text", validator: "text", core: true }),
  f({ key: "contact.country", category: "contact", label: { en: "Country", hi: "देश" }, input: "text", validator: "text" }),
  f({ key: "contact.pincode", category: "contact", label: { en: "PIN Code", hi: "पिन कोड" }, input: "text", validator: "pincode_in", core: true }),

  // Family
  f({ key: "family.father_name", category: "family", label: { en: "Father's Name", hi: "पिता का नाम" }, input: "text", validator: "person_name", core: true,
      aliases: ["father name", "name of father", "father's full name", "candidate's father's name", "पिताजी का नाम"] }),
  f({ key: "family.mother_name", category: "family", label: { en: "Mother's Name", hi: "माता का नाम" }, input: "text", validator: "person_name", core: true,
      aliases: ["mother name", "name of mother", "माँ का नाम"] }),
  f({ key: "family.guardian_name", category: "family", label: { en: "Guardian's Name", hi: "अभिभावक का नाम" }, input: "text", validator: "person_name" }),
  f({ key: "family.spouse_name", category: "family", label: { en: "Spouse's Name", hi: "पति/पत्नी का नाम" }, input: "text", validator: "person_name" }),

  // Identity (encrypted at rest)
  f({ key: "identity.aadhaar_number", category: "identity", label: { en: "Aadhaar Number", hi: "आधार संख्या" }, input: "text", validator: "aadhaar", sensitivity: "sensitive" }),
  f({ key: "identity.pan_number", category: "identity", label: { en: "PAN Number", hi: "पैन संख्या" }, input: "text", validator: "pan", sensitivity: "sensitive" }),
  f({ key: "identity.passport_number", category: "identity", label: { en: "Passport Number", hi: "पासपोर्ट संख्या" }, input: "text", validator: "passport_in", sensitivity: "sensitive" }),
  f({ key: "identity.driving_license_number", category: "identity", label: { en: "Driving Licence Number", hi: "ड्राइविंग लाइसेंस संख्या" }, input: "text", validator: "driving_license_in", sensitivity: "sensitive" }),
  f({ key: "identity.voter_id", category: "identity", label: { en: "Voter ID (EPIC)", hi: "मतदाता पहचान पत्र" }, input: "text", validator: "voter_id", sensitivity: "sensitive" }),

  // Education
  f({ key: "education.highest_qualification", category: "education", label: { en: "Highest Qualification", hi: "उच्चतम योग्यता" }, input: "text", validator: "text", core: true }),
  ...educationFields(),

  // Employment
  f({ key: "employment.company", category: "employment", label: { en: "Current Company", hi: "वर्तमान कंपनी" }, input: "text", validator: "text" }),
  f({ key: "employment.designation", category: "employment", label: { en: "Designation", hi: "पद" }, input: "text", validator: "text" }),
  f({ key: "employment.department", category: "employment", label: { en: "Department", hi: "विभाग" }, input: "text", validator: "text" }),
  f({ key: "employment.joining_date", category: "employment", label: { en: "Joining Date", hi: "कार्यग्रहण तिथि" }, input: "date", validator: "past_date" }),
  f({ key: "employment.experience_years", category: "employment", label: { en: "Total Experience (years)", hi: "कुल अनुभव (वर्ष)" }, input: "number", validator: "number" }),
  f({ key: "employment.salary", category: "employment", label: { en: "Current Salary (annual)", hi: "वर्तमान वेतन (वार्षिक)" }, input: "number", validator: "number", sensitivity: "sensitive" }),
  f({ key: "employment.notice_period", category: "employment", label: { en: "Notice Period", hi: "नोटिस अवधि" }, input: "text", validator: "text" }),
  f({ key: "employment.employee_id", category: "employment", label: { en: "Employee ID", hi: "कर्मचारी आईडी" }, input: "text", validator: "text" }),
  f({ key: "employment.skills", category: "employment", label: { en: "Key Skills", hi: "मुख्य कौशल" }, input: "textarea", validator: "text",
      aliases: ["skills", "technical skills", "key skills", "core competencies", "कौशल"] }),
  f({ key: "employment.summary", category: "employment", label: { en: "Professional Summary", hi: "पेशेवर सारांश" }, input: "textarea", validator: "text",
      aliases: ["profile summary", "career objective", "about me", "objective", "summary"] }),
  // Questions most job portals ask (Workday, Naukri, company career sites).
  f({ key: "employment.linkedin_url", category: "employment", label: { en: "LinkedIn Profile URL", hi: "लिंक्डइन प्रोफ़ाइल" }, input: "text", validator: "text",
      aliases: ["linkedin", "linkedin profile", "linkedin url", "linkedin profile url"] }),
  f({ key: "employment.desired_salary", category: "employment", label: { en: "Expected / Desired Salary", hi: "अपेक्षित वेतन" }, input: "text", validator: "text",
      aliases: ["desired salary", "expected salary", "expected ctc", "salary expectation", "please provide your desired salary"] }),
  f({ key: "employment.earliest_start_date", category: "employment", label: { en: "Earliest Start Date", hi: "कार्यभार ग्रहण की सबसे जल्दी तिथि" }, input: "date", validator: "date",
      aliases: ["earliest date you can start", "earliest start date", "date of availability", "available to join from", "when can you start"] }),
  f({ key: "employment.willing_to_relocate", category: "employment", label: { en: "Willing to Relocate", hi: "स्थानांतरण के लिए तैयार" }, input: "yes_no", validator: "yes_no",
      aliases: ["are you willing to relocate", "willing to relocate", "open to relocation", "ready to relocate"] }),
  f({ key: "employment.willing_to_travel", category: "employment", label: { en: "Willing to Travel (% of time)", hi: "यात्रा के लिए तैयार (% समय)" }, input: "text", validator: "text",
      aliases: ["percentage of time are you willing and able to travel", "willing to travel", "travel percentage", "how much can you travel"] }),
  f({ key: "employment.authorized_to_work", category: "employment", label: { en: "Eligible to Work in Job Location", hi: "कार्य स्थान पर काम करने के लिए पात्र" }, input: "yes_no", validator: "yes_no",
      aliases: ["eligible to work in the location", "legally authorized to work", "authorized to work", "work authorization", "right to work"] }),
  f({ key: "employment.needs_visa_sponsorship", category: "employment", label: { en: "Needs Visa Sponsorship", hi: "वीज़ा प्रायोजन चाहिए" }, input: "yes_no", validator: "yes_no",
      aliases: ["require sponsorship for employment visa", "visa sponsorship", "need sponsorship", "require sponsorship"] }),

  // Government / recruitment
  f({ key: "recruitment.category", category: "recruitment", label: { en: "Category", hi: "श्रेणी" }, input: "select", validator: "select", options: CATEGORIES, core: true, aliases: ["caste category", "वर्ग"] }),
  f({ key: "recruitment.caste", category: "recruitment", label: { en: "Caste / Sub-caste", hi: "जाति / उपजाति" }, input: "text", validator: "text" }),
  f({ key: "recruitment.caste_certificate_number", category: "recruitment", label: { en: "Caste Certificate Number", hi: "जाति प्रमाण पत्र संख्या" }, input: "text", validator: "text" }),
  f({ key: "recruitment.domicile_state", category: "recruitment", label: { en: "Domicile State", hi: "मूल निवास राज्य" }, input: "text", validator: "text" }),
  f({ key: "recruitment.ews", category: "recruitment", label: { en: "EWS", hi: "आर्थिक रूप से कमजोर वर्ग" }, input: "yes_no", validator: "yes_no" }),
  f({ key: "recruitment.pwd", category: "recruitment", label: { en: "Person with Disability (PwD)", hi: "दिव्यांग" }, input: "yes_no", validator: "yes_no", sensitivity: "sensitive" }),
  f({ key: "recruitment.ex_serviceman", category: "recruitment", label: { en: "Ex-Serviceman", hi: "भूतपूर्व सैनिक" }, input: "yes_no", validator: "yes_no", aliases: ["are you an ex-serviceman?"] }),
  f({ key: "recruitment.government_employee", category: "recruitment", label: { en: "Government Employee", hi: "सरकारी कर्मचारी" }, input: "yes_no", validator: "yes_no" }),
  f({ key: "recruitment.nationality_status", category: "recruitment", label: { en: "Nationality Status", hi: "राष्ट्रीयता स्थिति" }, input: "text", validator: "text" }),

  // Bank (restricted)
  f({ key: "bank.bank_name", category: "bank", label: { en: "Bank Name", hi: "बैंक का नाम" }, input: "text", validator: "text", sensitivity: "restricted" }),
  f({ key: "bank.account_number", category: "bank", label: { en: "Account Number", hi: "खाता संख्या" }, input: "text", validator: "bank_account", sensitivity: "restricted" }),
  f({ key: "bank.ifsc", category: "bank", label: { en: "IFSC", hi: "आईएफएससी" }, input: "text", validator: "ifsc", sensitivity: "restricted" }),
  f({ key: "bank.branch", category: "bank", label: { en: "Branch", hi: "शाखा" }, input: "text", validator: "text", sensitivity: "restricted" }),
];

const BY_KEY = new Map(PROFILE_FIELDS.map((d) => [d.key, d]));

export function getFieldDef(key: string): ProfileFieldDef | undefined {
  return BY_KEY.get(key);
}

export function isCatalogKey(key: string): boolean {
  return BY_KEY.has(key);
}

export const CUSTOM_FIELD_KEY_RE = /^custom\.[a-z0-9_]{1,60}$/;

export function isCustomKey(key: string): boolean {
  return CUSTOM_FIELD_KEY_RE.test(key);
}

export function fieldsByCategory(category: ProfileCategory): ProfileFieldDef[] {
  return PROFILE_FIELDS.filter((d) => d.category === category);
}

export function isEncryptedField(def: Pick<ProfileFieldDef, "sensitivity">): boolean {
  return def.sensitivity !== "normal";
}

/** Converts a free-text label to a custom field key: "Hobby Name" -> "custom.hobby_name". */
export function toCustomKey(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `custom.${slug || "field"}`;
}

/** Human-friendly display of a stored value (e.g. yes/no flags as "Yes"/"No"). */
export function formatFieldValue(key: string, value: string): string {
  const def = BY_KEY.get(key);
  if (def?.validator === "yes_no") return value === "yes" ? "Yes" : value === "no" ? "No" : value;
  return value;
}
