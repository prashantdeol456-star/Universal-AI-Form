import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseKeyring } from "./encryption";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { createRateLimiter } from "./rateLimit";
import { redact, redactObject } from "./redact";
import { generateOtp, signResource, verifySignedResource } from "./tokens";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse 42");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse 42", hash)).toBe(true);
    expect(await verifyPassword("correct horse 43", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it("produces different hashes for the same password (salted)", async () => {
    expect(await hashPassword("same password 1")).not.toBe(await hashPassword("same password 1"));
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
  });
});

describe("field encryption", () => {
  it("round-trips and uses a random IV", () => {
    const ring = parseKeyring(`k1:${k1}`);
    const a = encrypt(ring, "ABCPE1234F");
    const b = encrypt(ring, "ABCPE1234F");
    expect(a).not.toBe(b);
    expect(a).not.toContain("ABCPE1234F");
    expect(decrypt(ring, a)).toBe("ABCPE1234F");
  });

  it("detects tampering", () => {
    const ring = parseKeyring(`k1:${k1}`);
    const parts = encrypt(ring, "secret").split(":");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(ring, parts.join(":"))).toThrow();
  });

  it("supports key rotation: new primary encrypts, old key still decrypts", () => {
    const old = parseKeyring(`k1:${k1}`);
    const legacy = encrypt(old, "value");
    const rotated = parseKeyring(`k2:${k2},k1:${k1}`);
    expect(decrypt(rotated, legacy)).toBe("value");
    expect(encrypt(rotated, "value").split(":")[1]).toBe("k2");
  });

  it("rejects keys of the wrong length", () => {
    expect(() => parseKeyring(`k1:${randomBytes(16).toString("base64")}`)).toThrow();
  });
});

describe("tokens", () => {
  it("generates 6-digit OTPs", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it("signs and verifies expiring resource URLs", () => {
    const now = Date.now();
    const sig = signResource("s".repeat(32), "doc/123", 60, now);
    expect(verifySignedResource("s".repeat(32), "doc/123", sig, now)).toBe(true);
    expect(verifySignedResource("s".repeat(32), "doc/124", sig, now)).toBe(false);
    expect(verifySignedResource("s".repeat(32), "doc/123", sig, now + 61_000)).toBe(false);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit and resets after the window", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(true);
    const blocked = rl.consume("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(rl.consume("b").allowed).toBe(true);
    t = 1001;
    expect(rl.consume("a").allowed).toBe(true);
  });
});

describe("log redaction", () => {
  it("removes identifiers from strings", () => {
    const out = redact("user a@b.com pan ABCPE1234F aadhaar 2345 6789 0123 mobile +91 9876543210 otp=123456");
    expect(out).not.toMatch(/a@b\.com|ABCPE1234F|2345 6789 0123|9876543210|123456/);
  });

  it("redacts sensitive keys in objects", () => {
    expect(redactObject({ password: "x", nested: { token: "y", ok: "fine" } })).toEqual({
      password: "[REDACTED]",
      nested: { token: "[REDACTED]", ok: "fine" },
    });
  });
});
