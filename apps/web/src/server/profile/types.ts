// View types shared between the profile service and client components (no server-only imports).
import type { CompletionReport } from "@ufa/profile-engine";
import type { ProfileFieldSource } from "@ufa/shared";

export interface ProfileFieldView {
  fieldKey: string;
  value: string; // masked when sensitive
  masked: boolean;
  source: ProfileFieldSource;
  verified: boolean;
  confidence: number | null;
  updatedAt: string;
  lastVerifiedAt: string | null;
  sourceDocumentId: string | null;
}

export interface CustomFieldDefView {
  fieldKey: string;
  label: string;
  dataType: string;
  options: string[];
  isSensitive: boolean;
}

export interface ProfileView {
  fields: ProfileFieldView[];
  customFields: CustomFieldDefView[];
  openConflicts: number;
  completion: CompletionReport;
}

export interface HistoryEntry {
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  oldSource: string | null;
  newSource: string | null;
  reason: string | null;
  createdAt: string;
}
