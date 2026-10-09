import { describe, expect, it } from "vitest";
import type { NormalizedField } from "@ufa/form-engine";
import type { AnswerCache } from "./mapping/engine";
import { structureKey } from "./mapping/engine";
import type { ProfileValue } from "./mapping/types";
import { AIOrchestrator } from "./orchestrator";
import { GEMINI_MAX_CONFIDENCE, GeminiError, GeminiProvider } from "./providers/gemini";
import { MockAIProvider } from "./providers/mock";

let n = 0;
function field(label: string, extra: Partial<NormalizedField> = {}): NormalizedField {
  n++;
  return {
    id: `g${n}`, kind: "text", label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: false,
    options: [], autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true,
    disabled: false, readOnly: false, hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false,
    ...extra,
  };
}

const geminiReply = (mappings: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify({ mappings }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 45 },
    ...extra,
  }));

describe("GeminiProvider (mocked REST)", () => {
  it("sends minimal context with the key in a header and parses structured output", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return geminiReply([
        { field_id: "x1", profile_field: "family.guardian_name", confidence: 0.97 },
        { field_id: "x2", profile_field: "none", confidence: 0.9 },
        { field_id: "invented", profile_field: "family.father_name", confidence: 1 },
      ]);
    }) as unknown as typeof fetch;
    const g = new GeminiProvider({ apiKey: "test-key-123", model: "gemini-3.5-flash", fetchImpl });
    const res = await g.mapFields({
      fields: [
        { id: "x1", label: "Name of local guardian", section: "Hostel", kind: "text", options: [] },
        { id: "x2", label: "Preferred exam centre", section: null, kind: "select", options: ["Delhi", "Lucknow"] },
      ],
      candidates: [{ key: "family.guardian_name", label: "Guardian's Name" }, { key: "family.father_name", label: "Father's Name" }],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
    expect(seen[0]!.url).not.toContain("test-key-123");
    expect((seen[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key-123");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.properties.mappings.items.properties.profile_field.enum).toEqual(["family.guardian_name", "family.father_name", "none"]);
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual([
      { field_id: "x1", label: "Name of local guardian", section: "Hostel", type: "text", options: [] },
      { field_id: "x2", label: "Preferred exam centre", section: null, type: "select", options: ["Delhi", "Lucknow"] },
    ]);

    expect(res.suggestions).toEqual([
      { fieldId: "x1", profileField: "family.guardian_name", confidence: GEMINI_MAX_CONFIDENCE },
      { fieldId: "x2", profileField: null, confidence: GEMINI_MAX_CONFIDENCE },
    ]);
    expect(res.usage).toEqual({ inputTokens: 812, outputTokens: 45 });
  });

  it("retries once on 503/429 and never echoes error bodies", async () => {
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response("busy", { status: 503 }) : geminiReply([]))) as unknown as typeof fetch;
    await new GeminiProvider({ apiKey: "k", model: "m", fetchImpl: flaky }).mapFields({ fields: [{ id: "a", label: "x", section: null, kind: "text", options: [] }], candidates: [] });
    expect(calls).toBe(2);

    const bad = (async () => new Response('{"error":{"message":"API key not valid: test-key-123"}}', { status: 400 })) as unknown as typeof fetch;
    const err = await new GeminiProvider({ apiKey: "test-key-123", model: "m", fetchImpl: bad })
      .mapFields({ fields: [{ id: "a", label: "x", section: null, kind: "text", options: [] }], candidates: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(String((err as Error).message)).not.toContain("test-key-123");
  });

  it("refuses to start without an API key", () => {
    expect(() => new GeminiProvider({ apiKey: "", model: "m" })).toThrow();
  });
});

describe("orchestrator with the Gemini fallback", () => {
  const profile = new Map<string, ProfileValue>([
    ["family.father_name", { value: "Raj Kumar", verified: true, sensitive: false }],
    ["family.guardian_name", { value: "Ramesh", verified: true, sensitive: false }],
  ]);
  // No word of this label is in the lexicon, so only the fallback can resolve it.
  const hard = "Responsible adult residing nearby";

  it("asks Gemini only about fields nothing else could settle, and the user always confirms its answer", async () => {
    const gemini = new MockAIProvider("gemini", { [hard]: { field: "family.guardian_name", confidence: 0.99 } });
    const calls: Array<{ fallback?: boolean; usage?: unknown; suggestions?: unknown }> = [];
    const orch = new AIOrchestrator({ gemini });
    const res = await orch.mapForm({ fields: [field("Father's Name"), field(hard)], profile, onAiCall: (c) => calls.push(c) });

    expect(gemini.calls).toHaveLength(1);
    expect(gemini.calls[0]!.fields.map((f) => f.label)).toEqual([hard]);
    expect(JSON.stringify(gemini.calls[0])).not.toMatch(/Ramesh|Raj Kumar/);
    expect(res.mappings[0]).toMatchObject({ profileFieldKey: "family.father_name", decision: "AUTO_FILL" });
    expect(res.mappings[1]).toMatchObject({ profileFieldKey: "family.guardian_name", decision: "USER_REVIEW", reason: "ai_suggestion" });
    expect(res.gemini).toMatchObject({ status: "used", fieldsSent: 1, fieldsSuggested: 1 });
    expect(calls[0]).toMatchObject({ fallback: true, usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it("uses the shared answer cache instead of calling Gemini again", async () => {
    const store = new Map<string, { profileField: string | null; confidence: number }>();
    const cache: AnswerCache = {
      get: async (keys) => new Map(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)!])),
      set: async (entries) => entries.forEach((e) => store.set(e.key, { profileField: e.profileField, confidence: e.confidence })),
    };
    const gemini = new MockAIProvider("gemini", { [hard]: { field: "family.guardian_name", confidence: 0.9 } });
    const orch = new AIOrchestrator({ gemini, geminiCache: cache });
    await orch.mapForm({ fields: [field(hard)], profile });
    const second = await orch.mapForm({ fields: [field(hard)], profile });
    expect(gemini.calls).toHaveLength(1);
    expect(second.gemini).toMatchObject({ status: "cached", fieldsFromCache: 1, fieldsSent: 0 });
    expect(second.mappings[0]!.profileFieldKey).toBe("family.guardian_name");
    // Cache keys hold structure only.
    expect([...store.keys()][0]).toBe(structureKey(field(hard)));
  });

  it("respects the daily budget and the user's opt-out", async () => {
    const gemini = new MockAIProvider("gemini", { [hard]: { field: "family.guardian_name", confidence: 0.9 } });
    const orch = new AIOrchestrator({ gemini });
    const limited = await orch.mapForm({ fields: [field(hard)], profile, geminiBudget: 0 });
    expect(gemini.calls).toHaveLength(0);
    expect(limited.mappings[0]).toMatchObject({ decision: "GEMINI", reason: "unknown_field" });
    expect(limited.gemini.status).toBe("limit_reached");

    const optedOut = await orch.mapForm({ fields: [field(hard)], profile, allowCloudAi: false });
    expect(gemini.calls).toHaveLength(0);
    expect(optedOut.gemini.status).toBe("off");
    expect(optedOut.mappings[0]!.decision).toBe("ASK_USER");
  });

  it("keeps working when Gemini is down (no single point of failure)", async () => {
    const gemini = new MockAIProvider("gemini", {});
    gemini.mapFields = async () => {
      throw new GeminiError(503, "down");
    };
    const res = await new AIOrchestrator({ gemini }).mapForm({ fields: [field("Father's Name"), field(hard)], profile });
    expect(res.mappings[0]!.decision).toBe("AUTO_FILL");
    expect(res.mappings[1]!.decision).toBe("ASK_USER");
    expect(res.gemini.status).toBe("failed");
  });

  it("Gemini's 'none' is respected (no guessing)", async () => {
    const gemini = new MockAIProvider("gemini", { "Preferred exam centre": { field: null, confidence: 0.9 } });
    const res = await new AIOrchestrator({ gemini }).mapForm({ fields: [field("Preferred exam centre")], profile });
    expect(res.mappings[0]).toMatchObject({ profileFieldKey: null, decision: "ASK_USER" });
  });
});
