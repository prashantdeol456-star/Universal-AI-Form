// View types of the personal knowledge base (no server-only imports; used by routes and pages).

/** A bounded excerpt of one of the user's documents, with where it comes from. */
export interface KnowledgeExcerpt {
  /** Reference used in answers ("S1"). */
  ref: string;
  documentId: string;
  documentTitle: string;
  documentType: string;
  /** 1-based page (PDFs) or null. */
  page: number | null;
  section: string | null;
  text: string;
  score: number;
  /** The user allowed cloud AI to read this document. */
  cloudAiAllowed: boolean;
}

/** A value the user has (profile) or that a document suggests (not yet confirmed). */
export interface KnowledgeFact {
  key: string;
  label: string;
  /** Masked when the field is sensitive (ID numbers, bank details). */
  value: string;
  sensitive: boolean;
  /** Confirmed by the user (profile value marked verified). Extracted values are never verified until confirmed. */
  verified: boolean;
  source: "profile" | "document_extraction";
  /** How the profile value was entered ("user_input", "document", "chat", …) or the extraction method. */
  origin: string;
  sourceDocument: { id: string; title: string } | null;
}

export interface KnowledgeConflict {
  key: string;
  label: string;
  values: Array<{ value: string; source: string; documentTitle: string | null; verified: boolean }>;
}

export interface RetrievalResult {
  status: "found" | "not_found";
  query: string;
  excerpts: KnowledgeExcerpt[];
  facts: KnowledgeFact[];
  /** Different values for the same fact: the user decides which is right. */
  conflicts: KnowledgeConflict[];
}

export interface KnowledgeAnswer {
  status: "answered" | "not_found" | "conflict" | "excerpts_only";
  /** Generated wording (AI); null when no model was used. Never a verified fact. */
  summary: string | null;
  /** Statements that cite an excerpt and quote it exactly (checked by the server). */
  statements: Array<{ text: string; refs: string[]; quote: string }>;
  excerpts: KnowledgeExcerpt[];
  facts: KnowledgeFact[];
  conflicts: KnowledgeConflict[];
  /** Which model wrote the summary, or why none did. */
  engine: { provider: "local" | "gemini" | null; reason: string | null; dropped: number };
}
