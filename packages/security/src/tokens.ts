import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 256-bit URL-safe random token (session tokens, reset links). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Numeric one-time code, uniformly distributed. */
export function generateOtp(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, "0");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash for OTPs: keyed so a DB leak does not allow brute forcing 10^6 codes offline. */
export function hmacSha256(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Signed, expiring URL tokens for file downloads (replacement for Supabase
 * signed URLs). payload = `${resource}:${expiresAtEpochSeconds}`.
 */
export function signResource(secret: string, resource: string, ttlSeconds: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac("sha256", secret).update(`${resource}:${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifySignedResource(secret: string, resource: string, token: string, now = Date.now()): boolean {
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  const expected = createHmac("sha256", secret).update(`${resource}:${exp}`).digest("base64url");
  return safeEqual(sig, expected);
}
