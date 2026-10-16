/** Where a piece of evidence for a mapping came from (spec §28 confidence factors). */
export type EvidenceSource =
  | "autocomplete" // HTML autocomplete attribute
  | "lexicon" // multilingual concept rules
  | "fuzzy" // character-trigram similarity to known phrasings
  | "input_type" // e.g. type=email
  | "kb_website" // verified mapping for this exact website field
  | "kb_user" // the user's own confirmed mapping
  | "kb_global" // verified, anonymised global pattern
  | "semantic" // embedding similarity (local model)
  | "local_ai" // local LLM suggestion
  | "gemini" // Gemini fallback suggestion (always confirmed by the user)
  | "profile"; // the user's profile actually has a value for this field

export interface Evidence {
  source: EvidenceSource;
  /** Strength in [0,1] (negative values = evidence against). */
  weight: number;
  detail?: string;
}

export type Decision = "AUTO_FILL" | "USER_REVIEW" | "ASK_USER" | "GEMINI" | "MANUAL";

export type DecisionReason =
  | "confident"
  | "ai_suggestion"
  | "needs_review"
  | "ambiguous"
  | "value_unverified"
  | "sensitive"
  | "option_mismatch"
  | "missing_value"
  | "unknown_field"
  | "not_profile_field"
  | "captcha"
  | "otp"
  | "password"
  | "payment"
  | "suspicious"
  | "upload"
  | "declaration"
  | "conflicting_sources";

export interface ProfileValue {
  value: string;
  verified: boolean;
  sensitive: boolean;
}

/** What the knowledge base knows about a field. fieldKey null = "this is not a profile field". */
export interface KnowledgeHit {
  scope: "WEBSITE" | "USER" | "USER_ANY_SITE" | "GLOBAL";
  fieldKey: string | null;
  verified: boolean;
  successCount: number;
  failureCount: number;
  /** The form changed since this knowledge was confirmed: still used, but weighed less (double-check). */
  stale?: boolean;
}

export interface FieldMapping {
  fieldId: string;
  profileFieldKey: string | null;
  confidence: number;
  decision: Decision;
  reason: DecisionReason;
  /** Best alternatives (for review UIs). */
  candidates: Array<{ fieldKey: string; confidence: number }>;
  evidence: Evidence[];
  /** For select/radio/combobox: the option that matches the profile value. */
  optionMatch: string | null;
}

export const NOT_A_PROFILE_FIELD = "__none__";
