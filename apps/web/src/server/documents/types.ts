// View types shared by the document service, API routes and client components (no server-only imports).

export type DocumentStatus = "UPLOADED" | "PROCESSING" | "EXTRACTED" | "VERIFIED" | "FAILED";
export type ScanStatus = "PENDING" | "CLEAN" | "INFECTED" | "SKIPPED" | "ERROR";
export type ExtractionStatus = "PENDING" | "CONFIRMED" | "EDITED" | "REJECTED";

export interface DocumentSummary {
  id: string;
  documentType: string;
  title: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  status: DocumentStatus;
  scanStatus: ScanStatus;
  processingError: string | null;
  extractable: boolean;
  pendingCount: number;
  confirmedCount: number;
  createdAt: string;
  processedAt: string | null;
}

export interface ExtractionView {
  id: string;
  fieldKey: string;
  value: string;
  confidence: number | null;
  method: string;
  status: ExtractionStatus;
  sensitive: boolean;
  conflictId: string | null;
  /** The value currently in the master profile for this field (masked if sensitive). */
  profileValue: string | null;
  profileVerified: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  textEngine: string | null;
  textConfidence: number | null;
  localAiUsed: boolean;
  /** Short-lived signed URL for previewing/downloading the original file. */
  fileUrl: string;
  extractions: ExtractionView[];
}

export interface ConflictCandidateView {
  value: string;
  source: "profile" | "document";
  documentId: string | null;
  documentType: string | null;
  verified: boolean;
}

export interface ConflictView {
  id: string;
  fieldKey: string;
  candidates: ConflictCandidateView[];
  createdAt: string;
}

export type ConfirmResult =
  | { status: "created" | "updated" | "verified" | "unchanged"; fieldKey: string }
  | { status: "conflict"; fieldKey: string; conflictId: string };
