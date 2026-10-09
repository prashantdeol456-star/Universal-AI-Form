import { describe, expect, it } from "vitest";
import { dateFormatFor, formatDate, matchesPattern, prepareValue } from "./fill";
import type { NormalizedField } from "./types";

const field = (over: Partial<NormalizedField>): NormalizedField => ({
  id: "f1", kind: "text", label: "Field", labelSource: "label", name: null, htmlId: null, placeholder: null, section: null,
  required: false, options: [], autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en",
  visible: true, disabled: false, readOnly: false, hasValue: false, manual: null, accept: null, signature: "00000000",
  frame: "top", inShadowDom: false, ...over,
});
const text = (value: string, valueType: "text" | "date" | "yes_no" = "text", option: string | null = null) => ({ value, valueType, option });

describe("prepareValue", () => {
  it("never prepares CAPTCHA / OTP / password / file fields", () => {
    expect(prepareValue(field({ manual: "captcha" }), text("abc"))).toEqual({ ok: false, reason: "manual_field" });
    expect(prepareValue(field({ manual: "otp" }), text("123456"))).toEqual({ ok: false, reason: "manual_field" });
    expect(prepareValue(field({ kind: "password" }), text("x"))).toEqual({ ok: false, reason: "not_fillable" });
    expect(prepareValue(field({ kind: "file" }), text("x"))).toEqual({ ok: false, reason: "not_fillable" });
  });

  it("only picks one of the page's own options", () => {
    const f = field({ kind: "select", options: ["UR", "OBC", "SC"] });
    expect(prepareValue(f, text("General", "text", "UR"))).toEqual({ ok: true, value: "UR" });
    expect(prepareValue(f, text("General", "text", "General"))).toEqual({ ok: false, reason: "no_option" });
    expect(prepareValue(f, text("General"))).toEqual({ ok: false, reason: "no_option" });
  });

  it("converts dates to what the field expects", () => {
    expect(prepareValue(field({ kind: "date" }), text("2001-04-09", "date"))).toEqual({ ok: true, value: "2001-04-09" });
    expect(prepareValue(field({ placeholder: "DD/MM/YYYY" }), text("2001-04-09", "date"))).toEqual({ ok: true, value: "09/04/2001" });
    expect(prepareValue(field({ placeholder: "dd-mm-yyyy" }), text("2001-04-09", "date"))).toEqual({ ok: true, value: "09-04-2001" });
    expect(prepareValue(field({ hint: "Format: YYYY-MM-DD" }), text("2001-04-09", "date"))).toEqual({ ok: true, value: "2001-04-09" });
    expect(prepareValue(field({}), text("2001-04-09", "date"))).toEqual({ ok: true, value: "09/04/2001" });
    expect(prepareValue(field({ kind: "date" }), text("9 April", "date"))).toEqual({ ok: false, reason: "invalid_date" });
  });

  it("refuses instead of truncating or reformatting", () => {
    expect(prepareValue(field({ maxLength: 4 }), text("Ramesh"))).toEqual({ ok: false, reason: "too_long" });
    expect(prepareValue(field({ kind: "tel", pattern: "[6-9][0-9]{9}" }), text("9876543210"))).toEqual({ ok: true, value: "9876543210" });
    expect(prepareValue(field({ kind: "tel", pattern: "[6-9][0-9]{9}" }), text("+91 98765 43210"))).toEqual({ ok: false, reason: "pattern_mismatch" });
    expect(prepareValue(field({ kind: "email" }), text("not-an-email"))).toEqual({ ok: false, reason: "invalid_email" });
    expect(prepareValue(field({ kind: "number" }), text("five"))).toEqual({ ok: false, reason: "invalid_number" });
    // Hindi characters count as one each.
    expect(prepareValue(field({ maxLength: 5 }), text("राम"))).toEqual({ ok: true, value: "राम" });
  });

  it("ticks a single checkbox only for yes/no profile values", () => {
    expect(prepareValue(field({ kind: "checkbox" }), text("yes", "yes_no"))).toEqual({ ok: true, value: "true" });
    expect(prepareValue(field({ kind: "checkbox" }), text("no", "yes_no"))).toEqual({ ok: true, value: "false" });
    expect(prepareValue(field({ kind: "checkbox" }), text("Ramesh"))).toEqual({ ok: false, reason: "not_fillable" });
  });
});

describe("date and pattern helpers", () => {
  it("detects formats and formats dates", () => {
    expect(dateFormatFor(field({ placeholder: "MM/DD/YYYY" }))).toBe("mm/dd/yyyy");
    expect(dateFormatFor(field({ kind: "date" }))).toBe("iso");
    expect(formatDate("2001-04-09", "dd.mm.yyyy")).toBe("09.04.2001");
    expect(formatDate("09/04/2001", "iso")).toBeNull();
  });

  it("uses HTML pattern semantics and ignores invalid patterns", () => {
    expect(matchesPattern("123456", "\\d{6}")).toBe(true);
    expect(matchesPattern("1234567", "\\d{6}")).toBe(false);
    expect(matchesPattern("abc", "[")).toBe(true);
  });
});
