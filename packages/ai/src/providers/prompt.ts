import type { FieldForAI } from "./types";

/**
 * The exact prompt the local model sees (spec §50). Shared by LocalAIProvider at
 * inference time and by the training-data generator (phase 11), so a fine-tuned
 * model is trained on precisely the format it will be asked in production.
 * Changing this text means retraining — keep it stable and versioned.
 */
export const LOCAL_MAPPING_PROMPT_VERSION = 1;

export interface PromptCandidate {
  key: string;
  label: string;
}

export function localMappingSystemPrompt(candidates: PromptCandidate[]): string {
  return (
    "You map fields of Indian online application forms (English, Hindi or Hinglish labels) to a person's profile fields. " +
    'For each form field choose exactly one profile field key from the allowed list, or "none" if no key fits or you are unsure. ' +
    'Never guess: wrong answers are worse than "none". Reply with JSON only.\n' +
    `Allowed keys:\n${candidates.map((c) => `${c.key} = ${c.label}`).join("\n")}`
  );
}

export function localMappingUserPrompt(fields: FieldForAI[]): string {
  return JSON.stringify(fields.map((f) => ({ field_id: f.id, label: f.label, section: f.section, type: f.kind, options: f.options.slice(0, 12) })));
}

/** JSON schema the model's reply must follow (Ollama `format`). */
export function localMappingFormat(keys: string[]) {
  return {
    type: "object",
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          properties: { field_id: { type: "string" }, profile_field: { type: "string", enum: [...keys, "none"] }, confidence: { type: "number" } },
          required: ["field_id", "profile_field", "confidence"],
        },
      },
    },
    required: ["mappings"],
  } as const;
}
