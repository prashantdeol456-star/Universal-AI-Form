import { describe, expect, it } from "vitest";
import { can } from "../roles";
import { getFieldDef, isCustomKey, PROFILE_FIELDS, toCustomKey } from "./catalog";
import { maskValue } from "./mask";

describe("profile catalog", () => {
  it("has unique keys that match the database key format", () => {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z_]+(\.[a-z0-9_]+)+$/);
  });

  it("every field key starts with its category", () => {
    for (const f of PROFILE_FIELDS) expect(f.key.startsWith(`${f.category}.`)).toBe(true);
  });

  it("marks identity and bank fields as encrypted and bank as restricted", () => {
    expect(getFieldDef("identity.aadhaar_number")?.sensitivity).toBe("sensitive");
    for (const f of PROFILE_FIELDS.filter((d) => d.category === "bank")) expect(f.sensitivity).toBe("restricted");
  });

  it("includes Hindi labels for every field", () => {
    for (const f of PROFILE_FIELDS) expect(f.label.hi.length).toBeGreaterThan(0);
    expect(getFieldDef("family.father_name")?.label.hi).toBe("पिता का नाम");
  });

  it("generates safe custom keys", () => {
    expect(toCustomKey("NCC Certificate Grade")).toBe("custom.ncc_certificate_grade");
    expect(isCustomKey(toCustomKey("!!!"))).toBe(true);
  });

  it("masks values keeping the last four characters", () => {
    expect(maskValue("234567890123")).toBe("••••••••0123");
    expect(maskValue("12")).toBe("••");
  });

  it("enforces role permissions", () => {
    expect(can("CUSTOMER", "profile:write_own")).toBe(true);
    expect(can("CUSTOMER", "admin:audit_view")).toBe(false);
    expect(can("CAFE_OPERATOR", "cafe:operators_manage")).toBe(false);
    expect(can("CAFE_OWNER", "cafe:operators_manage")).toBe(true);
  });
});
