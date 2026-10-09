import { describe, expect, it } from "vitest";
import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import { isFillCommand, isOpenQuestion, matchOption, planFill } from "./agent";
import type { FieldMappingView, MapResult } from "./api";

let n = 0;
function field(label: string, extra: Partial<NormalizedField> = {}): NormalizedField {
  n++;
  return {
    id: `f${n}`, kind: "text", label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: true, options: [],
    autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true, disabled: false, readOnly: false,
    hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false, ...extra,
  };
}
function mapped(f: NormalizedField, key: string | null, value: string | null, extra: Partial<FieldMappingView> = {}): FieldMappingView {
  return {
    fieldId: f.id, profileFieldKey: key, profileFieldLabel: key, profileFieldLabelHi: null, value, valueVerified: false, optionMatch: null, confidence: 0.9,
    decision: key ? "AUTO_FILL" : "ASK_USER", reason: "high_confidence" as never, sources: [], candidates: [], savedAnswer: null, ...extra,
  };
}

describe("planFill (Hostripples-style application)", () => {
  const name = field("Full name");
  const city = field("Current city / location");
  const about = field("Tell us about yourself", { kind: "textarea", required: false });
  const heard = field("How did you hear about us?", { kind: "select", options: ["LinkedIn", "Naukri", "Friend"] });
  const captcha = field("Security check (CAPTCHA)", { manual: "captcha" as never });
  const agree = field("I agree to Hostripples using my details and resume", { kind: "checkbox", options: [] });
  const optional = field("Portfolio link", { required: false });
  const snapshot = { fields: [name, city, about, heard, captcha, agree, optional] } as unknown as FormSnapshot;
  const mapping = {
    fields: [
      mapped(name, "personal.full_name", "Prashant Deol"),
      mapped(city, "contact.city", null),
      mapped(about, null, null),
      mapped(heard, null, null, { savedAnswer: "LinkedIn" }),
      mapped(optional, null, null),
    ],
  } as unknown as MapResult;

  it("fills known values, reuses saved answers, writes open answers and asks only for required unknowns", () => {
    const p = planFill(snapshot, mapping);
    expect(p.selection[name.id]).toEqual({ include: true, manualValue: "", overwrite: false });
    expect(p.selection[heard.id]?.manualValue).toBe("LinkedIn");
    expect(p.write.map((f) => f.label)).toEqual(["Tell us about yourself"]);
    expect(p.ask.map((a) => a.field.label)).toEqual(["Current city / location"]);
    expect(p.ask[0]!.mapping?.profileFieldKey).toBe("contact.city");
    // CAPTCHA and the consent box stay with the user; the optional link is not asked.
    expect(p.yours.map((f) => f.label)).toEqual(["Security check (CAPTCHA)", "I agree to Hostripples using my details and resume"]);
    expect(p.selection[captcha.id]).toBeUndefined();
    expect(p.ask.some((a) => a.field.id === optional.id)).toBe(false);
  });

  it("recognises open questions, chat commands and option replies", () => {
    expect(isOpenQuestion(field("Why do you think you are suitable for this position?"))).toBe(true);
    expect(isOpenQuestion(field("Current city"))).toBe(false);
    expect(isFillCommand("fill")).toBe(true);
    expect(isFillCommand("form bharo")).toBe(true);
    expect(isFillCommand("my city is Noida")).toBe(false);
    expect(matchOption(["Yes", "No"], "haan")).toBe("Yes");
    expect(matchOption(["LinkedIn", "Naukri", "Friend"], "naukri")).toBe("Naukri");
    expect(matchOption(["LinkedIn", "Naukri"], "newspaper")).toBeNull();
    expect(matchOption([], "Noida")).toBe("Noida");
  });
});

describe("roleOf", () => {
  it("reads the job title from the form or page title", async () => {
    const { roleOf } = await import("./agent");
    const snap = (formTitle: string | null, pageTitle = "") => ({ formTitle, pageTitle }) as unknown as FormSnapshot;
    expect(roleOf(snap("Apply: Product Owner"))).toBe("Product Owner");
    expect(roleOf(snap(null, "Application for Accountant – Sharma Traders"))).toBe("Accountant");
    expect(roleOf(snap("Contact us"))).toBeNull();
  });
});
