import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hotp, totp, verifyTotp } from "./totp";

// RFC 6238 appendix B (SHA-1): secret = "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 4226 HOTP vectors", () => {
    const s = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 3, 9].map((c) => hotp(s, c))).toEqual(["755224", "287082", "359152", "969429", "520489"]);
  });

  it("matches the RFC 6238 TOTP vectors (8 digits)", () => {
    expect(totp(RFC_SECRET, 59_000, 8)).toBe("94287082");
    expect(totp(RFC_SECRET, 1111111109_000, 8)).toBe("07081804");
    expect(totp(RFC_SECRET, 1234567890_000, 8)).toBe("89005924");
    expect(totp(RFC_SECRET, 20000000000_000, 8)).toBe("65353130");
  });

  it("accepts ±1 step of clock drift and nothing else", () => {
    const secret = generateTotpSecret();
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, t), t)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 90_000), t)).toBeNull();
    expect(verifyTotp(secret, "12345", t)).toBeNull();
    expect(verifyTotp(secret, "abcdef", t)).toBeNull();
  });

  it("round-trips base32 and makes distinct recovery codes", () => {
    const buf = Buffer.from("any bytes \u0000ÿ");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });
});
