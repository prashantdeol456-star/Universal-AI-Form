import { describe, expect, it } from "vitest";
import { isCatalogKey, PROFILE_FIELDS } from "@ufa/shared";
import { NOT_A_PROFILE_FIELD } from "../mapping/types";
import { localMappingSystemPrompt } from "../providers/prompt";
import {
  cleanExamples,
  containsPII,
  dedupeExamples,
  eligibleExamples,
  splitOf,
  toChatRecords,
  validateDataset,
  type RawExample,
} from "./dataset";
import { computeMetrics, promotionDecision, type Prediction } from "./metrics";

let n = 0;
const ex = (label: string, key: string, over: Partial<RawExample> = {}): RawExample => ({
  id: `e${++n}`,
  source: "USER_VERIFIED",
  status: "PENDING",
  contributorId: "u1",
  domain: "ssc.gov.in",
  label,
  section: "Personal Details",
  type: "text",
  options: [],
  language: "en",
  key,
  ...over,
});

describe("eligibility", () => {
  it("needs admin approval or two different people for the same label → key", () => {
    const raw = [ex("Father's Name", "family.father_name", { contributorId: "u1" }), ex("Fathers name", "family.father_name", { contributorId: "u1" })];
    expect(eligibleExamples(raw).eligible).toHaveLength(0);
    raw.push(ex("Father's Name", "family.father_name", { contributorId: "u2" }));
    expect(eligibleExamples(raw).eligible).toHaveLength(3);
    expect(eligibleExamples([ex("Nationality", "personal.nationality", { status: "APPROVED" })]).eligible).toHaveLength(1);
    expect(eligibleExamples([ex("X", "personal.nationality", { status: "REMOVED", contributorId: "a" }), ex("X", "personal.nationality", { status: "REMOVED", contributorId: "b" })]).eligible).toHaveLength(0);
  });
});

describe("cleaning", () => {
  it("detects personal data but not ordinary labels", () => {
    expect(containsPII("Aadhaar Number")).toBeNull();
    expect(containsPII("Class 10 passing year 2026")).toBeNull();
    expect(containsPII("Aadhaar 1234 5678 9012")).toBe("long_number");
    expect(containsPII("Call 98765-43210")).toBe("long_number");
    expect(containsPII("ram@example.com")).toBe("email");
    expect(containsPII("PAN ABCPE1234F")).toBe("pan");
  });

  it("drops PII, unknown keys and empty labels; strips personal options", () => {
    const { kept, dropped } = cleanExamples(
      [
        ex("  Father's   Name ", "family.father_name"),
        ex("Name 9876543210", "personal.full_name"),
        ex("Weird", "made.up_key"),
        ex("***", "personal.full_name"),
        ex("Category", "recruitment.category", { options: ["UR", "OBC", "call 9876543210"] }),
        ex("Captcha code", NOT_A_PROFILE_FIELD),
      ],
      isCatalogKey,
    );
    expect(kept.map((k) => k.label)).toEqual(["Father's Name", "Category", "Captcha code"]);
    expect(kept[1]!.options).toEqual(["UR", "OBC"]);
    expect(dropped).toEqual({ pii: 1, unknown_key: 1, empty_label: 1 });
  });
});

describe("dedupe and conflicts", () => {
  it("merges duplicates and drops fields people disagree on", () => {
    const { examples, conflicts } = dedupeExamples([
      ex("Father's Name", "family.father_name", { contributorId: "a" }),
      ex("Father's Name", "family.father_name", { contributorId: "b" }),
      ex("Name", "personal.full_name", { contributorId: "a" }),
      ex("Name", "family.father_name", { contributorId: "b" }),
    ]);
    expect(conflicts).toBe(1);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ key: "family.father_name", contributors: 2, ids: expect.any(Array) });
  });

  it("keeps a clear majority (≥ 80 %)", () => {
    const rows = ["a", "b", "c", "d"].map((c) => ex("Mother's Name", "family.mother_name", { contributorId: c }));
    rows.push(ex("Mother's Name", "family.father_name", { contributorId: "e" }));
    expect(dedupeExamples(rows).examples.map((e) => e.key)).toEqual(["family.mother_name"]);
  });
});

describe("splits and records", () => {
  it("never puts the same wording in train and test", () => {
    const s1 = splitOf("fathers name", "seed-1");
    expect(splitOf("fathers name", "seed-1")).toBe(s1);
    const counts = { train: 0, validation: 0, test: 0 };
    for (let i = 0; i < 2000; i++) counts[splitOf(`label ${i}`, "seed-1")]++;
    expect(counts.test).toBeGreaterThan(120);
    expect(counts.test).toBeLessThan(280);
    expect(counts.train).toBeGreaterThan(1450);
  });

  it("produces chat records in exactly the inference prompt, with 'none' targets", () => {
    const { examples } = dedupeExamples([ex("Father's Name", "family.father_name"), ex("Captcha code", NOT_A_PROFILE_FIELD)]);
    const candidates = PROFILE_FIELDS.map((d) => ({ key: d.key, label: d.label.en }));
    const [rec] = toChatRecords(examples, candidates, { seed: "s", batchSize: 6 });
    expect(rec!.messages[0]!.content).toBe(localMappingSystemPrompt(candidates));
    const user = JSON.parse(rec!.messages[1]!.content) as Array<{ field_id: string; label: string }>;
    const answer = JSON.parse(rec!.messages[2]!.content) as { mappings: Array<{ field_id: string; profile_field: string }> };
    const byLabel = Object.fromEntries(user.map((u) => [u.label, answer.mappings.find((m) => m.field_id === u.field_id)!.profile_field]));
    expect(byLabel).toEqual({ "Father's Name": "family.father_name", "Captcha code": "none" });
    // Records contain structure only.
    expect(JSON.stringify(rec)).not.toMatch(/contributor|ssc\.gov\.in|u1/);
  });

  it("refuses to validate a tiny dataset", () => {
    const { examples } = dedupeExamples([ex("Father's Name", "family.father_name")]);
    const report = validateDataset(examples.map((e) => ({ ...e, split: "train" as const })));
    expect(report.errors.join(" ")).toMatch(/minimum 50/);
  });
});

describe("metrics and promotion", () => {
  const p = (expected: string | null, predicted: string | null, confidence = 0.9, language = "en"): Prediction => ({ id: String(++n), expected, predicted, confidence, language });

  it("counts wrong answers separately from abstentions", () => {
    const m = computeMetrics([
      p("family.father_name", "family.father_name"),
      p("family.father_name", null),
      p("family.mother_name", "family.father_name"),
      p(null, null),
      p(null, "personal.full_name", 0.6, "hi"),
    ]);
    expect(m).toMatchObject({ n: 5, accuracy: 0.4, coverage: 0.6, abstentionRate: 0.4, wrongRate: 0.4, precision: 0.3333 });
    expect(m.perLanguage.hi).toEqual({ n: 1, accuracy: 0, wrongRate: 1 });
    expect(m.topErrors[0]!.count).toBe(1);
  });

  it("measures calibration", () => {
    const good = computeMetrics(Array.from({ length: 10 }, (_, i) => p("a.b", i < 9 ? "a.b" : "a.c", 0.9)));
    const over = computeMetrics(Array.from({ length: 10 }, (_, i) => p("a.b", i < 5 ? "a.b" : "a.c", 0.95)));
    expect(good.ece).toBeLessThan(0.05);
    expect(over.ece).toBeGreaterThan(0.4);
  });

  it("promotes only a model that is better and not more often wrong", () => {
    const mk = (acc: number, wrong: number) => ({ ...computeMetrics([]), n: 200, accuracy: acc, wrongRate: wrong });
    expect(promotionDecision(mk(0.9, 0.01), mk(0.85, 0.01)).ok).toBe(true);
    expect(promotionDecision(mk(0.92, 0.03), mk(0.85, 0.01)).reasons.join(" ")).toMatch(/above 2.0%/);
    expect(promotionDecision(mk(0.84, 0.01), mk(0.85, 0.01)).ok).toBe(false);
    expect(promotionDecision({ ...mk(0.9, 0.01), n: 10 }, null).reasons.join(" ")).toMatch(/too small/);
    expect(promotionDecision(mk(0.9, 0.015), null).ok).toBe(true);
  });
});
