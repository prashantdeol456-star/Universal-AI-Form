/**
 * Provider abstraction (spec §25, §102). Business logic depends only on this
 * interface; LocalAIProvider (Ollama), GeminiProvider and mock providers for
 * tests plug in without changes elsewhere.
 *
 * Contract for every provider:
 *  - returns structured data only (validated by the caller), never code;
 *  - may abstain (profileField: null) — "I don't know" is a valid answer;
 *  - receives the minimum context: labels/sections/types/options and the list
 *    of possible profile field keys — never profile values or documents.
 */
export interface FieldForAI {
  id: string;
  label: string;
  section: string | null;
  kind: string;
  options: string[];
}

export interface FieldSuggestion {
  fieldId: string;
  profileField: string | null;
  /** Provider's own confidence — capped and treated as one signal among many. */
  confidence: number;
}

export interface MapFieldsInput {
  fields: FieldForAI[];
  /** Allowed answers: profile field keys with their English labels. */
  candidates: Array<{ key: string; label: string }>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MapFieldsResult {
  suggestions: FieldSuggestion[];
  usage?: TokenUsage;
}

export interface AIProvider {
  readonly name: "local" | "gemini" | "mock";
  readonly model: string;
  mapFields(input: MapFieldsInput): Promise<MapFieldsResult>;
  /** Text embeddings for semantic search; optional (not every provider/model supports it). */
  embed?(texts: string[]): Promise<number[][]>;
}
