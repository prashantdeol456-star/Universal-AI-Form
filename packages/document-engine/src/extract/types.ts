export type ExtractionMethod = "rules" | "local_ai" | "rules+local_ai";

/** One proposed profile value found in a document. Never written to the profile without user confirmation. */
export interface ExtractedCandidate {
  fieldKey: string;
  value: string;
  /** Our own score in [0,1]; model self-reported confidence is capped before it lands here. */
  confidence: number;
  method: ExtractionMethod;
}
