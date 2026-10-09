import { describe, expect, it } from "vitest";
import { validateValue, verhoeffValid } from "./validators";

function withVerhoeffCheckDigit(first11: string): string {
  for (let d = 0; d <= 9; d++) if (verhoeffValid(first11 + d)) return first11 + d;
  throw new Error("unreachable");
}

describe("validators", () => {
  it("accepts Aadhaar numbers with a valid Verhoeff checksum and normalizes spaces", () => {
    const valid = withVerhoeffCheckDigit("23456789012");
    const spaced = `${valid.slice(0, 4)} ${valid.slice(4, 8)} ${valid.slice(8)}`;
    expect(validateValue("aadhaar", spaced)).toEqual({ ok: true, value: valid });
  });

  it("rejects Aadhaar with a wrong checksum or leading 0/1", () => {
    const valid = withVerhoeffCheckDigit("23456789012");
    const wrong = valid.slice(0, 11) + ((Number(valid[11]) + 1) % 10);
    expect(validateValue("aadhaar", wrong).ok).toBe(false);
    expect(validateValue("aadhaar", "123456789012").ok).toBe(false);
  });

  it("validates PAN format and uppercases", () => {
    expect(validateValue("pan", "abcpe1234f")).toEqual({ ok: true, value: "ABCPE1234F" });
    expect(validateValue("pan", "ABCDE12345").ok).toBe(false);
  });

  it("normalizes Indian mobile numbers", () => {
    expect(validateValue("mobile_in", "+91 98765-43210")).toEqual({ ok: true, value: "9876543210" });
    expect(validateValue("mobile_in", "09876543210")).toEqual({ ok: true, value: "9876543210" });
    expect(validateValue("mobile_in", "5876543210").ok).toBe(false);
  });

  it("parses ISO and Indian date formats and rejects impossible dates", () => {
    expect(validateValue("date", "12/05/2001")).toEqual({ ok: true, value: "2001-05-12" });
    expect(validateValue("date", "2001-05-12")).toEqual({ ok: true, value: "2001-05-12" });
    expect(validateValue("date", "31/02/2001").ok).toBe(false);
    expect(validateValue("past_date", "2999-01-01").ok).toBe(false);
  });

  it("validates PIN code, IFSC, percentage, CGPA and year", () => {
    expect(validateValue("pincode_in", "110001").ok).toBe(true);
    expect(validateValue("pincode_in", "010001").ok).toBe(false);
    expect(validateValue("ifsc", "sbin0001234")).toEqual({ ok: true, value: "SBIN0001234" });
    expect(validateValue("ifsc", "SBIN1001234").ok).toBe(false);
    expect(validateValue("percentage", "87.456%")).toEqual({ ok: true, value: "87.46" });
    expect(validateValue("percentage", "101").ok).toBe(false);
    expect(validateValue("cgpa", "8.5").ok).toBe(true);
    expect(validateValue("cgpa", "11").ok).toBe(false);
    expect(validateValue("year", "1890").ok).toBe(false);
  });

  it("understands yes/no in English, Hinglish and Hindi", () => {
    expect(validateValue("yes_no", "Haan")).toEqual({ ok: true, value: "yes" });
    expect(validateValue("yes_no", "नहीं")).toEqual({ ok: true, value: "no" });
    expect(validateValue("yes_no", "maybe").ok).toBe(false);
  });

  it("matches select options case-insensitively and returns the canonical option", () => {
    expect(validateValue("select", "obc", { options: ["General", "OBC"] })).toEqual({ ok: true, value: "OBC" });
    expect(validateValue("select", "XYZ", { options: ["General", "OBC"] }).ok).toBe(false);
  });

  it("accepts Devanagari names", () => {
    expect(validateValue("person_name", "राज कुमार").ok).toBe(true);
    expect(validateValue("person_name", "Raj <script>").ok).toBe(false);
  });
});
