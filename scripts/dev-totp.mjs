/**
 * DEV ONLY: computes the current authenticator code (RFC 6238, SHA-1, 6 digits, 30 s)
 * for the local dev admin, whose secret lives in .data/dev-admin.json. Used by
 * scripts/seed-dev-admin.mjs --mfa and the test-form /__dev/dashboard sign-in.
 * Same algorithm as packages/security/src/totp.ts (kept dependency-free here).
 */
import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, "")) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function devTotp(secretBase32, at = Date.now()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
