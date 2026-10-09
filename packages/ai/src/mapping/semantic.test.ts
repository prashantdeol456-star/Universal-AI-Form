import { describe, expect, it } from "vitest";
import type { AIProvider } from "../providers/types";
import { SemanticIndex, type LabelVectorStore } from "./semantic";

/** Deterministic fake embeddings: one dimension per distinctive word. */
const VOCAB = ["father", "mother", "guardian", "nearby", "adult", "pita"];
const embed = (t: string) => VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01));
const provider: AIProvider = {
  name: "mock",
  model: "fake",
  mapFields: async () => ({ suggestions: [] }),
  embed: async (texts) => texts.map(embed),
};

describe("SemanticIndex with a shared-label vector store", () => {
  it("uses a stored (learned) label when it is closer than any reference phrase", async () => {
    const store: LabelVectorStore = { nearest: async (vs) => vs.map(() => ({ fieldKey: "family.guardian_name", score: 0.99, phrase: "responsible adult residing nearby" })) };
    const [hit] = await new SemanticIndex(provider, store).nearest(["Responsible adult residing nearby"]);
    expect(hit).toMatchObject({ fieldKey: "family.guardian_name", phrase: "responsible adult residing nearby" });
  });

  it("falls back to the in-process reference phrases when the store fails or is absent", async () => {
    const broken: LabelVectorStore = { nearest: async () => Promise.reject(new Error("pgvector down")) };
    const [a] = await new SemanticIndex(provider, broken).nearest(["Father name"]);
    const [b] = await new SemanticIndex(provider).nearest(["Father name"]);
    expect(a?.fieldKey).toBe(b?.fieldKey);
    expect(a?.fieldKey).toMatch(/^family\.father/);
  });
});
