import { describe, expect, it } from "vitest";
import { generateAccessCode, normalizeAccessCode } from "./accessCode";

describe("access codes", () => {
  it("look like XXXX-XXXX without confusable characters", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateAccessCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(normalizeAccessCode(c)).toBe(c.replace("-", ""));
    }
  });

  it("accept what people type and reject everything else", () => {
    expect(normalizeAccessCode(" k7m2 qx9p ")).toBe("K7M2QX9P");
    expect(normalizeAccessCode("K7M2-QX9")).toBeNull();
    expect(normalizeAccessCode("K7M2-QX9O")).toBeNull(); // O → 0, not in the alphabet
    expect(normalizeAccessCode("K7M2-QX9!")).toBeNull();
  });

  it("are not repeated in practice", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateAccessCode));
    expect(seen.size).toBe(2000);
  });
});
