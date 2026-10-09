import { describe, expect, it } from "vitest";
import type { NormalizedField } from "@ufa/form-engine";
import { PROFILE_FIELDS } from "@ufa/shared";
import { MockAIProvider } from "../providers/mock";
import { LocalAIProvider, LOCAL_MAX_CONFIDENCE } from "../providers/local";
import benchmark from "./benchmark.json";
import { combine, knowledgeEvidence } from "./confidence";
import { mapForm } from "./engine";
import { conceptsOf } from "./lexicon";
import { matchOption } from "./options";
import { SemanticIndex } from "./semantic";
import type { ProfileValue } from "./types";

let n = 0;
export function field(label: string, extra: Partial<NormalizedField> = {}): NormalizedField {
  n++;
  return {
    id: `f${n}`, kind: "text", label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: false,
    options: [], autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true,
    disabled: false, readOnly: false, hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false,
    ...extra,
  };
}

/** A profile that has a verified value for every catalog field. */
function fullProfile(): Map<string, ProfileValue> {
  const special: Record<string, string> = {
    "personal.gender": "Male", "recruitment.category": "General", "recruitment.ex_serviceman": "no", "personal.marital_status": "Unmarried",
    "education.highest_qualification": "Graduation",
  };
  return new Map(PROFILE_FIELDS.map((d) => [d.key, { value: special[d.key] ?? "x", verified: true, sensitive: d.sensitivity !== "normal" }]));
}

describe("lexicon", () => {
  it("reduces English, Hindi and Hinglish to the same concepts", () => {
    for (const l of ["Father's Name", "Name of Father", "पिता का नाम", "pitaji ka naam"]) {
      expect([...conceptsOf(l).concepts].sort()).toEqual(["FATHER", "NAME"]);
    }
  });
});

describe("benchmark (spec §41: accuracy, wrong-mapping rate, abstention)", () => {
  it("maps the labelled benchmark accurately and almost never wrongly", async () => {
    const items = benchmark as Array<{ label: string; section?: string; kind?: NormalizedField["kind"]; options?: string[]; expected: string | null; mustReview?: boolean }>;
    const fields = items.map((b) => field(b.label, { section: b.section ?? null, kind: b.kind ?? "text", options: b.options ?? [] }));
    const res = await mapForm({ fields, profile: fullProfile() });
    let correct = 0;
    let wrong = 0;
    let abstained = 0;
    const errors: string[] = [];
    res.mappings.forEach((m, i) => {
      const exp = items[i]!.expected;
      const got = m.profileFieldKey;
      if (got === exp && items[i]!.mustReview && m.decision === "AUTO_FILL") {
        wrong++;
        errors.push(`WRONG: ambiguous "${items[i]!.label}" was auto-filled`);
      } else if (got === exp) correct++;
      else if (got === null) {
        abstained++;
        errors.push(`abstained: "${items[i]!.label}" (expected ${exp})`);
      } else {
        wrong++;
        errors.push(`WRONG: "${items[i]!.label}" -> ${got} (expected ${exp}, ${m.confidence})`);
      }
    });
    const accuracy = correct / items.length;
    const wrongRate = wrong / items.length;
    console.info(`benchmark: ${items.length} labels · accuracy ${(accuracy * 100).toFixed(1)}% · wrong ${(wrongRate * 100).toFixed(1)}% · abstained ${abstained}\n${errors.join("\n")}`);
    expect(wrongRate).toBeLessThanOrEqual(0.02);
    expect(accuracy).toBeGreaterThanOrEqual(0.93);
  });
});

describe("decisions", () => {
  const profile = new Map<string, ProfileValue>([
    ["family.father_name", { value: "Raj Kumar", verified: true, sensitive: false }],
    ["personal.gender", { value: "Male", verified: true, sensitive: false }],
    ["recruitment.category", { value: "General", verified: true, sensitive: false }],
    ["identity.aadhaar_number", { value: "234567890123", verified: true, sensitive: true }],
    ["family.mother_name", { value: "Sunita", verified: false, sensitive: false }],
  ]);
  const one = async (f: NormalizedField, extra: Partial<Parameters<typeof mapForm>[0]> = {}) => (await mapForm({ fields: [f], profile, ...extra })).mappings[0]!;

  it("auto-fills confident matches with a verified value", async () => {
    expect(await one(field("Father's Name"))).toMatchObject({ profileFieldKey: "family.father_name", decision: "AUTO_FILL", reason: "confident" });
  });
  it("matches option labels: General -> UR, Male -> M", async () => {
    expect(await one(field("Category", { kind: "select", options: ["UR", "OBC", "SC", "ST"] }))).toMatchObject({ decision: "AUTO_FILL", optionMatch: "UR" });
    expect(await one(field("Gender", { kind: "radio", options: ["M", "F", "T"] }))).toMatchObject({ optionMatch: "M" });
  });
  it("asks for review when the option cannot be matched", async () => {
    expect(await one(field("Category", { kind: "select", options: ["BC-A", "BC-B"] }))).toMatchObject({ decision: "USER_REVIEW", reason: "option_mismatch" });
  });
  it("never auto-fills sensitive or unverified values", async () => {
    expect(await one(field("Aadhaar Number"))).toMatchObject({ decision: "USER_REVIEW", reason: "sensitive" });
    expect(await one(field("Mother's Name"))).toMatchObject({ decision: "USER_REVIEW", reason: "value_unverified" });
  });
  it("asks the user when the profile has no value", async () => {
    expect(await one(field("Email ID", { kind: "email" }))).toMatchObject({ profileFieldKey: "contact.email", decision: "ASK_USER", reason: "missing_value" });
  });
  it("flags ambiguity: Father / Guardian Name", async () => {
    const m = await one(field("Father / Guardian Name"));
    expect(m.decision).not.toBe("AUTO_FILL");
  });
  it("keeps CAPTCHA, OTP, uploads and declarations manual", async () => {
    expect(await one(field("Enter the characters shown in the image", { manual: "captcha" }))).toMatchObject({ decision: "MANUAL", reason: "captcha" });
    expect(await one(field("Upload Photograph", { kind: "file" }))).toMatchObject({ decision: "MANUAL", reason: "upload" });
    expect(await one(field("I hereby declare that the information is true", { kind: "checkbox" }))).toMatchObject({ decision: "MANUAL", reason: "declaration" });
  });
  it("does not guess unknown fields ('I don't know' is allowed)", async () => {
    expect(await one(field("Preferred Exam Centre"))).toMatchObject({ profileFieldKey: null, decision: "ASK_USER", reason: "unknown_field" });
    expect(await one(field("Preferred Exam Centre"), { fallbackAvailable: true })).toMatchObject({ decision: "GEMINI" });
  });
  it("respects type compatibility: a name never goes into a date picker", async () => {
    const m = await one(field("Father's Name", { kind: "date" }));
    expect(m.decision).not.toBe("AUTO_FILL");
  });
});

describe("knowledge base", () => {
  const profile = new Map<string, ProfileValue>([["family.guardian_name", { value: "Ramesh", verified: true, sensitive: false }]]);

  it("a verified website mapping settles an otherwise unknown label", async () => {
    const f = field("Name of the person responsible");
    const knowledge = new Map([[f.id, [{ scope: "WEBSITE" as const, fieldKey: "family.guardian_name", verified: true, successCount: 30, failureCount: 0 }]]]);
    expect((await mapForm({ fields: [f], profile, knowledge })).mappings[0]).toMatchObject({ profileFieldKey: "family.guardian_name", decision: "AUTO_FILL" });
  });
  it("'not a profile field' feedback suppresses mapping", async () => {
    const f = field("Father's Name");
    const knowledge = new Map([[f.id, [{ scope: "USER" as const, fieldKey: null, verified: true, successCount: 1, failureCount: 0 }]]]);
    expect((await mapForm({ fields: [f], profile, knowledge })).mappings[0]).toMatchObject({ decision: "MANUAL", reason: "not_profile_field" });
  });
  it("a user's correction resolves an ambiguous label", async () => {
    const f = field("Father / Guardian Name");
    const knowledge = new Map([[f.id, [
      { scope: "USER" as const, fieldKey: "family.guardian_name", verified: true, successCount: 1, failureCount: 0 },
      { scope: "USER" as const, fieldKey: "family.father_name", verified: false, successCount: 0, failureCount: 1 },
    ]]]);
    const m = (await mapForm({ fields: [f], profile, knowledge })).mappings[0]!;
    expect(m).toMatchObject({ profileFieldKey: "family.guardian_name", decision: "AUTO_FILL" });
    expect(m.confidence).toBeGreaterThan(0.9);
  });
  it("a mapping that keeps failing becomes evidence against itself", () => {
    expect(knowledgeEvidence({ scope: "USER", fieldKey: "x", verified: false, successCount: 0, failureCount: 1 }).weight).toBeLessThan(0);
    expect(knowledgeEvidence({ scope: "WEBSITE", fieldKey: "x", verified: true, successCount: 1, failureCount: 9 }).weight).toBeLessThan(0);
    expect(combine([{ source: "lexicon", weight: 0.9 }, { source: "kb_user", weight: -0.7 }])).toBeLessThan(0.3);
  });
});

describe("AI stages (mock providers, no network)", () => {
  const profile = new Map<string, ProfileValue>([["family.guardian_name", { value: "Ramesh", verified: true, sensitive: false }]]);

  it("calls local AI only for fields the rules could not settle, with minimal context", async () => {
    const ai = new MockAIProvider("local", { "Name of the person responsible": { field: "family.guardian_name", confidence: 0.99 } });
    const res = await mapForm({ fields: [field("Father's Name"), field("Name of the person responsible")], profile, localAi: ai });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.fields.map((f) => f.label)).toEqual(["Name of the person responsible"]);
    expect(JSON.stringify(ai.calls[0])).not.toContain("Ramesh"); // never profile values
    const m = res.mappings[1]!;
    // model said 0.99 -> capped: model alone can only suggest, not auto-fill
    expect(m).toMatchObject({ profileFieldKey: null, decision: "ASK_USER" });
    expect(m.confidence).toBeLessThan(0.7);
  });

  it("model + other evidence together can reach review", async () => {
    const ai = new MockAIProvider("local", { "Guardian (if father not alive)": { field: "family.guardian_name", confidence: 0.8 } });
    const res = await mapForm({ fields: [field("Guardian (if father not alive)")], profile, localAi: ai });
    expect(res.mappings[0]!.profileFieldKey).toBe("family.guardian_name");
  });

  it("survives a failing provider (no single point of failure)", async () => {
    const ai = new MockAIProvider("local", {});
    ai.mapFields = async () => {
      throw new Error("down");
    };
    const calls: boolean[] = [];
    const res = await mapForm({ fields: [field("Father's Name"), field("Something odd")], profile, localAi: ai, onAiCall: (c) => calls.push(c.success) });
    expect(res.mappings[0]!.profileFieldKey).toBe("family.father_name");
    expect(calls).toEqual([false]);
  });

  it("semantic search adds evidence from embeddings", async () => {
    const vec = (k: number) => [Math.cos(k), Math.sin(k), 0];
    const vectors: Record<string, number[]> = { "Responsible adult": vec(0.1) };
    const ai = new MockAIProvider("local", {}, new Proxy(vectors, { get: (t, p: string) => t[p] ?? (p.includes("guardian") || p.includes("अभिभावक") ? vec(0.12) : vec(2)) }));
    const res = await mapForm({ fields: [field("Responsible adult")], profile, semantic: new SemanticIndex(ai) });
    expect(res.semanticUsed).toBe(true);
    expect(res.mappings[0]!.candidates[0]!.fieldKey).toBe("family.guardian_name");
  });
});

describe("LocalAIProvider (mocked Ollama)", () => {
  it("validates output, caps confidence, ignores invented ids and keys", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.format.properties.mappings.items.properties.profile_field.enum).toContain("none");
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ mappings: [
        { field_id: "a", profile_field: "family.father_name", confidence: 0.99 },
        { field_id: "b", profile_field: "none", confidence: 0.9 },
        { field_id: "zzz", profile_field: "family.mother_name", confidence: 0.9 },
        { field_id: "c", profile_field: "made.up_key", confidence: 0.9 },
      ] }) } }));
    }) as typeof fetch;
    const p = new LocalAIProvider({ baseUrl: "http://ai", model: "m", fetchImpl });
    const out = await p.mapFields({
      fields: ["a", "b", "c"].map((id) => ({ id, label: id, section: null, kind: "text", options: [] })),
      candidates: [{ key: "family.father_name", label: "Father's Name" }, { key: "family.mother_name", label: "Mother's Name" }],
    });
    expect(out.suggestions).toEqual([
      { fieldId: "a", profileField: "family.father_name", confidence: LOCAL_MAX_CONFIDENCE },
      { fieldId: "b", profileField: null, confidence: 0.8 },
      { fieldId: "c", profileField: null, confidence: 0.8 },
    ]);
  });
});

describe("option matching", () => {
  it("handles synonyms, case and Hindi", () => {
    expect(matchOption("General", ["UR", "OBC"])).toBe("UR");
    expect(matchOption("no", ["YES", "NO"])).toBe("NO");
    expect(matchOption("Female", ["पुरुष", "महिला"])).toBe("महिला");
    expect(matchOption("Uttar Pradesh", ["Bihar", "UTTAR PRADESH (UP)"])).toBe("UTTAR PRADESH (UP)");
    expect(matchOption("Graduation", ["10th", "12th", "Graduate", "Post Graduate"])).toBe("Graduate");
    expect(matchOption("OBC", ["General", "SC"])).toBeNull();
  });
});

describe("job portal questions (Workday-style)", () => {
  it("maps common application questions to their profile fields", async () => {
    const { ruleHits } = await import("./rules");
    const top = (label: string, kind: "text" | "select" | "date" = "text") =>
      ruleHits({ id: "q", kind, label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: false, options: kind === "select" ? ["Yes", "No"] : [], autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true, disabled: false, readOnly: false, hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false })
        .sort((a, b) => b.evidence.weight - a.evidence.weight)[0]?.fieldKey;
    expect(top("Please provide your desired salary.")).toBe("employment.desired_salary");
    expect(top("Current CTC")).toBe("employment.salary");
    expect(top("LinkedIn Profile")).toBe("employment.linkedin_url");
    expect(top("Are you willing to Relocate?", "select")).toBe("employment.willing_to_relocate");
    expect(top("Will you now or in the future require sponsorship for employment visa status?", "select")).toBe("employment.needs_visa_sponsorship");
    expect(top("Are you eligible to work in the location where this role is advertised?", "select")).toBe("employment.authorized_to_work");
    expect(top("What is the earliest date you can start employment?", "date")).toBe("employment.earliest_start_date");
  });
});
