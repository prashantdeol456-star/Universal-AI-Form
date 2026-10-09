import { describe, expect, it } from "vitest";
import { knowledgeEvidence } from "../mapping/confidence";
import { NOT_A_PROFILE_FIELD } from "../mapping/types";
import { diffFormVersions } from "./change";
import { decidePromotions, globalSignature, isGeneralisableLabel, voteFromUserMapping, type MappingVote } from "./promotion";

const vote = (userId: string, key: string, over: Partial<MappingVote> = {}): MappingVote => ({
  userId,
  domain: "ssc.gov.in",
  fieldSignature: "aaaa1111",
  label: "Father's Name",
  normalizedLabel: "fathers name",
  key,
  polarity: 1,
  ...over,
});

describe("decidePromotions — website knowledge", () => {
  it("never promotes what only one person said", () => {
    expect(decidePromotions([vote("u1", "family.father_name")])).toEqual([]);
  });

  it("promotes a field mapping two different users agree on", () => {
    const p = decidePromotions([vote("u1", "family.father_name"), vote("u2", "family.father_name")]);
    expect(p).toEqual([expect.objectContaining({ scope: "WEBSITE", domain: "ssc.gov.in", fieldSignature: "aaaa1111", key: "family.father_name", support: 2, against: 0 })]);
  });

  it("counts a user once, however many times they confirmed", () => {
    expect(decidePromotions([vote("u1", "family.father_name"), vote("u1", "family.father_name")])).toEqual([]);
  });

  it("does not promote when people disagree", () => {
    const votes = [vote("u1", "family.father_name"), vote("u2", "family.father_name"), vote("u3", "family.guardian_name")];
    expect(decidePromotions(votes).filter((p) => p.scope === "WEBSITE")).toEqual([]);
  });

  it("treats 'marked wrong' as evidence against", () => {
    const votes = [vote("u1", "family.father_name"), vote("u2", "family.father_name"), vote("u3", "family.father_name", { polarity: -1 })];
    expect(decidePromotions(votes).filter((p) => p.scope === "WEBSITE")).toEqual([]);
    const more = [...votes, vote("u4", "family.father_name"), vote("u5", "family.father_name"), vote("u6", "family.father_name")];
    expect(decidePromotions(more).find((p) => p.scope === "WEBSITE")).toMatchObject({ support: 5, against: 1 });
  });

  it("can learn that a field is not a profile field on one website", () => {
    const p = decidePromotions([vote("u1", NOT_A_PROFILE_FIELD), vote("u2", NOT_A_PROFILE_FIELD)]);
    expect(p.map((x) => [x.scope, x.key])).toEqual([["WEBSITE", NOT_A_PROFILE_FIELD]]);
  });
});

describe("decidePromotions — global patterns", () => {
  const across = (users: string[], key = "family.father_name") =>
    users.map((u, i) => vote(u, key, { domain: i % 2 ? "upsc.gov.in" : "ssc.gov.in", fieldSignature: i % 2 ? "bbbb2222" : "aaaa1111" }));

  it("needs three users on at least two websites", () => {
    expect(decidePromotions(across(["u1", "u2"])).some((p) => p.scope === "GLOBAL")).toBe(false);
    const sameSite = ["u1", "u2", "u3"].map((u) => vote(u, "family.father_name"));
    expect(decidePromotions(sameSite).some((p) => p.scope === "GLOBAL")).toBe(false);
    const g = decidePromotions(across(["u1", "u2", "u3"])).find((p) => p.scope === "GLOBAL");
    expect(g).toMatchObject({ domain: null, key: "family.father_name", support: 3, domains: 2, fieldSignature: globalSignature("fathers name") });
  });

  it("never generalises vague or personal-looking labels, or 'not a profile field'", () => {
    const vague = ["u1", "u2", "u3"].map((u, i) => vote(u, "personal.full_name", { normalizedLabel: "name", label: "Name", domain: `site${i}.in` }));
    expect(decidePromotions(vague).some((p) => p.scope === "GLOBAL")).toBe(false);
    const none = across(["u1", "u2", "u3"], NOT_A_PROFILE_FIELD);
    expect(decidePromotions(none).some((p) => p.scope === "GLOBAL")).toBe(false);
  });

  it("label rules", () => {
    expect(isGeneralisableLabel("fathers name")).toBe(true);
    expect(isGeneralisableLabel("nationality")).toBe(true);
    expect(isGeneralisableLabel("पिता का नाम")).toBe(true);
    expect(isGeneralisableLabel("name")).toBe(false);
    expect(isGeneralisableLabel("dob")).toBe(false);
    expect(isGeneralisableLabel("roll no 2026123")).toBe(false);
    expect(isGeneralisableLabel("mail me at a@b.in")).toBe(false);
  });
});

describe("votes from user mappings", () => {
  const row = { user_id: "u1", domain: "x.in", field_signature: "s", field_label: "L", normalized_label: "l", profile_field_key: "k" };
  it("only verified, mostly-successful mappings count for; only plain failures count against", () => {
    expect(voteFromUserMapping({ ...row, verified: true, success_count: 2, failure_count: 0 })?.polarity).toBe(1);
    expect(voteFromUserMapping({ ...row, verified: false, success_count: 3, failure_count: 0 })).toBeNull();
    expect(voteFromUserMapping({ ...row, verified: false, success_count: 0, failure_count: 1 })?.polarity).toBe(-1);
    expect(voteFromUserMapping({ ...row, verified: true, success_count: 1, failure_count: 1 })).toBeNull();
    expect(voteFromUserMapping({ ...row, domain: null, verified: true, success_count: 1, failure_count: 0 })).toBeNull();
  });
});

describe("form change detection", () => {
  it("ignores fields that only appear dynamically, reports real additions and removals", () => {
    const lastApplied = ["a", "b", "c"];
    const knownBefore = ["a", "b", "c", "district"]; // District appeared after choosing a State
    expect(diffFormVersions(["a", "b", "c"], knownBefore, lastApplied)).toEqual({ added: 0, removed: 0 });
    expect(diffFormVersions(["a", "b", "c", "district"], knownBefore, lastApplied)).toEqual({ added: 0, removed: 0 });
    expect(diffFormVersions(["a", "c", "new1", "new2"], knownBefore, lastApplied)).toEqual({ added: 2, removed: 1 });
  });

  it("weighs knowledge about a changed form less", () => {
    const hit = { scope: "WEBSITE" as const, fieldKey: "family.father_name", verified: true, successCount: 3, failureCount: 0 };
    expect(knowledgeEvidence({ ...hit, stale: true }).weight).toBeLessThan(knowledgeEvidence(hit).weight);
    expect(knowledgeEvidence({ ...hit, stale: true }).weight).toBeLessThan(0.9);
  });
});
