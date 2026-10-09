export const PROFILE_FIELD_SOURCES = [
  "user_input",
  "chat",
  "document",
  "local_ai",
  "gemini",
  "application",
  "admin",
] as const;
export type ProfileFieldSource = (typeof PROFILE_FIELD_SOURCES)[number];

export const APPLICATION_STATUSES = [
  "DRAFT",
  "IN_PROGRESS",
  "WAITING_FOR_USER",
  "READY_FOR_REVIEW",
  "CONFIRMED",
  "SUBMITTED",
  "FAILED",
  "CANCELLED",
  "ARCHIVED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses after which the field snapshot is immutable (enforced by DB trigger too). */
export const IMMUTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "CONFIRMED",
  "SUBMITTED",
  "ARCHIVED",
];

export const AI_DECISIONS = ["AUTO_FILL", "USER_REVIEW", "ASK_USER", "GEMINI", "MANUAL"] as const;
export type AIDecision = (typeof AI_DECISIONS)[number];

export const LEARNING_SOURCES = [
  "USER_VERIFIED",
  "GEMINI_USER_VERIFIED",
  "LOCAL_AI_USER_VERIFIED",
  "SUCCESSFUL_APPLICATION",
  "USER_CORRECTION",
  "ADMIN_VERIFIED",
] as const;
export type LearningSource = (typeof LEARNING_SOURCES)[number];

/** Permissions a café can request in an access session. 'bank' is intentionally absent. */
export const CAFE_PERMISSIONS = [
  "basic_profile",
  "contact",
  "family",
  "education",
  "employment",
  "recruitment",
  "identity",
  "documents",
  "applications",
  "custom",
] as const;
export type CafePermission = (typeof CAFE_PERMISSIONS)[number];

export const DOCUMENT_TYPES = [
  "aadhaar",
  "pan",
  "class_10_marksheet",
  "class_12_marksheet",
  "graduation_marksheet",
  "graduation_certificate",
  "degree",
  "diploma",
  "caste_certificate",
  "domicile_certificate",
  "ews_certificate",
  "disability_certificate",
  "experience_certificate",
  "salary_slip",
  "resume",
  "photograph",
  "signature",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, { en: string; hi: string }> = {
  aadhaar: { en: "Aadhaar Card", hi: "आधार कार्ड" },
  pan: { en: "PAN Card", hi: "पैन कार्ड" },
  class_10_marksheet: { en: "Class 10 Marksheet", hi: "कक्षा 10 अंकपत्र" },
  class_12_marksheet: { en: "Class 12 Marksheet", hi: "कक्षा 12 अंकपत्र" },
  graduation_marksheet: { en: "Graduation Marksheet", hi: "स्नातक अंकपत्र" },
  graduation_certificate: { en: "Graduation Certificate", hi: "स्नातक प्रमाण पत्र" },
  degree: { en: "Degree", hi: "उपाधि" },
  diploma: { en: "Diploma", hi: "डिप्लोमा" },
  caste_certificate: { en: "Caste Certificate", hi: "जाति प्रमाण पत्र" },
  domicile_certificate: { en: "Domicile Certificate", hi: "मूल निवास प्रमाण पत्र" },
  ews_certificate: { en: "EWS Certificate", hi: "ईडब्ल्यूएस प्रमाण पत्र" },
  disability_certificate: { en: "Disability Certificate", hi: "दिव्यांगता प्रमाण पत्र" },
  experience_certificate: { en: "Experience Certificate", hi: "अनुभव प्रमाण पत्र" },
  salary_slip: { en: "Salary Slip", hi: "वेतन पर्ची" },
  resume: { en: "Resume / CV", hi: "बायोडाटा" },
  photograph: { en: "Photograph", hi: "फोटो" },
  signature: { en: "Signature", hi: "हस्ताक्षर" },
  other: { en: "Other", hi: "अन्य" },
};
