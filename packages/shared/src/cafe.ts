/**
 * Cyber café mode (phase 10): what a customer can share with a café operator.
 * Mirrors the `cafe_permissions.permission` check constraint and
 * `app.field_permission()` in the database. Bank details are deliberately absent:
 * they can never be shared with a café.
 */
import { CAFE_PERMISSIONS, type CafePermission } from "./constants";

export type { CafePermission };

export const CAFE_PERMISSION_LABELS: Record<CafePermission, { en: string; hi: string; hint: string }> = {
  basic_profile: { en: "Basic details", hi: "मूल विवरण", hint: "Name, date of birth, gender, category, nationality" },
  contact: { en: "Contact & address", hi: "संपर्क और पता", hint: "Mobile, email, address, PIN code" },
  family: { en: "Family", hi: "परिवार", hint: "Father, mother, guardian, spouse names" },
  education: { en: "Education", hi: "शिक्षा", hint: "Boards, marks, years of passing" },
  employment: { en: "Employment", hi: "रोज़गार", hint: "Occupation, experience" },
  recruitment: { en: "Recruitment details", hi: "भर्ती विवरण", hint: "Category, ex-serviceman, PwD, domicile" },
  identity: { en: "ID numbers", hi: "पहचान संख्या", hint: "Aadhaar, PAN, voter ID, passport — sensitive" },
  documents: { en: "Documents", hi: "दस्तावेज़", hint: "Your uploaded files (photo, signature, certificates)" },
  applications: { en: "Save the application", hi: "आवेदन सहेजें", hint: "Needed to fill a form and keep it in your history" },
  custom: { en: "Custom fields", hi: "अन्य फ़ील्ड", hint: "Fields you added yourself" },
};

/** Default selection for a normal form-filling visit (no ID numbers or documents unless chosen). */
export const DEFAULT_CAFE_PERMISSIONS: CafePermission[] = ["basic_profile", "contact", "family", "education", "recruitment", "applications"];

export const CAFE_SESSION_DURATIONS = [30, 60, 120, 240, 480, 720] as const;
export const CAFE_MAX_SESSION_MINUTES = 720;
export const CAFE_CODE_TTL_MINUTES = 15;

export const isCafePermission = (p: string): p is CafePermission => (CAFE_PERMISSIONS as readonly string[]).includes(p);

/** Which café permission covers a profile field (same rule as `app.field_permission()` in SQL). Bank → never. */
export function cafePermissionForField(fieldKey: string): CafePermission | null {
  const map: Record<string, CafePermission> = {
    personal: "basic_profile",
    contact: "contact",
    family: "family",
    education: "education",
    employment: "employment",
    recruitment: "recruitment",
    identity: "identity",
    custom: "custom",
  };
  return map[fieldKey.split(".")[0] ?? ""] ?? null;
}
