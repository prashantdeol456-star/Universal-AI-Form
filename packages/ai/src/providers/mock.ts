import type { AIProvider, MapFieldsInput, MapFieldsResult } from "./types";

/**
 * Deterministic provider for tests (spec §76): no network. Answers from a
 * fixed label → field table, abstains otherwise, and records what it was asked
 * so tests can assert that only minimal context was sent.
 */
export class MockAIProvider implements AIProvider {
  readonly model = "mock-1";
  readonly calls: MapFieldsInput[] = [];

  constructor(
    readonly name: "local" | "gemini" | "mock",
    private readonly answers: Record<string, { field: string | null; confidence: number }>,
    private readonly vectors?: Record<string, number[]>,
  ) {}

  async mapFields(input: MapFieldsInput): Promise<MapFieldsResult> {
    this.calls.push(input);
    return {
      suggestions: input.fields.map((f) => {
        const a = this.answers[f.label];
        return { fieldId: f.id, profileField: a?.field ?? null, confidence: a?.confidence ?? 0 };
      }),
      usage: { inputTokens: 100 * input.fields.length, outputTokens: 20 * input.fields.length },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.vectors) throw new Error("No vectors configured");
    return texts.map((t) => this.vectors![t] ?? [0, 0, 1]);
  }
}
