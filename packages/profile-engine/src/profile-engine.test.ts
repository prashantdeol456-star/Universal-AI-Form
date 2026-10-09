import { describe, expect, it } from "vitest";
import { PROFILE_FIELDS } from "@ufa/shared";
import { computeCompletion } from "./completion";
import { decideFieldUpdate, type ExistingFieldState } from "./decide";

const verified = (value: string): ExistingFieldState => ({ value, source: "user_input", verified: true, confidence: 1 });
const unverified = (value: string, confidence = 0.8): ExistingFieldState => ({ value, source: "document", verified: false, confidence });

describe("decideFieldUpdate", () => {
  it("creates when nothing exists", () => {
    expect(decideFieldUpdate(null, { value: "Raj Kumar", source: "chat", userConfirmed: true })).toEqual({ action: "CREATE", verified: true });
    expect(decideFieldUpdate(null, { value: "Raj Kumar", source: "document", userConfirmed: false })).toEqual({ action: "CREATE", verified: false });
  });

  it("is a no-op for the same value ignoring case and whitespace", () => {
    expect(decideFieldUpdate(verified("Raj Kumar"), { value: "  raj   kumar ", source: "chat", userConfirmed: true }).action).toBe("NOOP");
  });

  it("verifies an unverified value when the user confirms the same value", () => {
    expect(decideFieldUpdate(unverified("Raj Kumar"), { value: "Raj Kumar", source: "user_input", userConfirmed: true })).toEqual({ action: "VERIFY" });
  });

  it("never silently overwrites a verified value (spec example: Raj Kumar -> Rajesh Kumar)", () => {
    const d = decideFieldUpdate(verified("Raj Kumar"), { value: "Rajesh Kumar", source: "chat", userConfirmed: true });
    expect(d.action).toBe("CONFLICT");
  });

  it("overwrites a verified value only with explicit user confirmation", () => {
    const d = decideFieldUpdate(verified("Raj Kumar"), { value: "Rajesh Kumar", source: "chat", userConfirmed: true, confirmOverwrite: true });
    expect(d).toEqual({ action: "UPDATE", verified: true });
  });

  it("does not let unverified AI/document data replace verified data even with confirmOverwrite", () => {
    const d = decideFieldUpdate(verified("2001-05-12"), { value: "2001-05-15", source: "document", userConfirmed: false, confirmOverwrite: true });
    expect(d.action).toBe("CONFLICT");
  });

  it("replaces unverified data with user-confirmed data", () => {
    expect(decideFieldUpdate(unverified("2001-05-12"), { value: "2001-05-15", source: "user_input", userConfirmed: true })).toEqual({ action: "UPDATE", verified: true });
  });

  it("flags disagreeing unverified sources as a conflict unless the newcomer is more confident", () => {
    expect(decideFieldUpdate(unverified("2001-05-12", 0.9), { value: "2001-05-15", source: "document", userConfirmed: false, confidence: 0.7 }).action).toBe("CONFLICT");
    expect(decideFieldUpdate(unverified("2001-05-12", 0.5), { value: "2001-05-15", source: "document", userConfirmed: false, confidence: 0.95 })).toEqual({ action: "UPDATE", verified: false });
  });
});

describe("computeCompletion", () => {
  const core = PROFILE_FIELDS.filter((f) => f.core);

  it("is 0% for an empty profile and lists all core fields as missing", () => {
    const r = computeCompletion([]);
    expect(r.percent).toBe(0);
    expect(r.missingCore).toHaveLength(core.length);
  });

  it("is 100% when every core field is present, and tracks verification separately", () => {
    const r = computeCompletion(core.map((f, i) => ({ fieldKey: f.key, verified: i % 2 === 0 })));
    expect(r.percent).toBe(100);
    expect(r.verifiedPercent).toBeLessThan(100);
    expect(r.missingCore).toEqual([]);
  });

  it("ignores non-core fields", () => {
    expect(computeCompletion([{ fieldKey: "personal.religion", verified: true }]).percent).toBe(0);
  });
});
