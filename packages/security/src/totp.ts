import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 / RFC 4226): the codes authenticator
 * apps (Google Authenticator, Microsoft Authenticator, Aegis…) show. HMAC-SHA1,
 * 30-second steps, 6 digits — the defaults every app supports.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
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

/** A new random secret (160 bits, base32) for enrolment. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, at = Date.now(), digits = 6, step = 30): string {
  return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / step), digits);
}

/**
 * Checks a code, allowing one step of clock drift either way. Returns the
 * matched time step so callers can refuse re-use of the same code.
 */
export function verifyTotp(secretBase32: string, code: string, at = Date.now(), window = 1): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretBase32);
  const now = Math.floor(at / 1000 / 30);
  for (let d = -window; d <= window; d++) {
    const expected = hotp(secret, now + d);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return now + d;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (entered as a key, or shown as a QR code). */
export function totpUri(secretBase32: string, account: string, issuer = "Universal AI Form Assistant"): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** One-time recovery codes (shown once; store only their hashes). */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(6)).slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
