import type { DocumentType } from "@ufa/shared";

/** Which education level a document type describes (maps to education.<level>.*). */
export function educationLevelFor(type: DocumentType): string | null {
  switch (type) {
    case "class_10_marksheet":
      return "class_10";
    case "class_12_marksheet":
      return "class_12";
    case "graduation_marksheet":
    case "graduation_certificate":
    case "degree":
      return "graduation";
    case "diploma":
      return "diploma";
    default:
      return null;
  }
}

const PERSON = ["personal.full_name", "personal.date_of_birth", "family.father_name", "family.mother_name"];

/**
 * Profile fields that a document type may legitimately provide. Anything an
 * extractor (rules or AI) returns outside this list is dropped — e.g. an AI
 * model "finding" a bank account number on a marksheet.
 */
export function allowedFieldsFor(type: DocumentType): string[] {
  const edu = educationLevelFor(type);
  if (edu) {
    const school = edu === "class_10" || edu === "class_12";
    const eduKeys = school
      ? ["board", "school", "passing_year", "percentage", "roll_number", ...(edu === "class_12" ? ["stream"] : [])]
      : ["course", "specialization", "university", "college", "cgpa", "percentage", "passing_year", "roll_number", "registration_number"];
    return [...PERSON, ...eduKeys.map((k) => `education.${edu}.${k}`)];
  }
  switch (type) {
    case "aadhaar":
      return ["identity.aadhaar_number", "personal.full_name", "personal.date_of_birth", "personal.gender", "family.father_name", "family.spouse_name", "contact.address_line_1", "contact.pincode", "contact.state", "contact.district", "contact.city"];
    case "pan":
      return ["identity.pan_number", "personal.full_name", "family.father_name", "personal.date_of_birth"];
    case "caste_certificate":
      return ["personal.full_name", "family.father_name", "recruitment.caste", "recruitment.category", "recruitment.caste_certificate_number"];
    case "domicile_certificate":
      return ["personal.full_name", "family.father_name", "recruitment.domicile_state"];
    case "ews_certificate":
      return ["personal.full_name", "family.father_name", "recruitment.ews"];
    case "disability_certificate":
      return ["personal.full_name", "recruitment.pwd"];
    case "experience_certificate":
      return ["personal.full_name", "employment.company", "employment.designation", "employment.joining_date"];
    case "salary_slip":
      return ["personal.full_name", "employment.company", "employment.designation", "employment.employee_id", "employment.department"];
    case "resume":
      return ["personal.full_name", "contact.email", "contact.mobile", "personal.date_of_birth", "employment.company", "employment.designation", "employment.skills", "employment.summary", "employment.linkedin_url",
        "education.highest_qualification", "education.graduation.course", "education.graduation.specialization", "education.graduation.university", "education.graduation.passing_year", "education.post_graduation.course", "education.post_graduation.specialization", "education.post_graduation.university", "education.post_graduation.passing_year"];
    default:
      // photograph, signature, other: no automatic extraction
      return [];
  }
}

/** Document types that are stored for upload into forms but never OCR'd. */
export function isExtractable(type: DocumentType): boolean {
  return allowedFieldsFor(type).length > 0;
}
