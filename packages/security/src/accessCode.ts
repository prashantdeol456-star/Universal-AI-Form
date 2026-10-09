import { randomInt } from "node:crypto";

/**
 * Short codes a person reads aloud (e.g. a customer's café access code):
 * 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as
 * "K7M2-QX9P". 31^8 ≈ 8.5 × 10^11 combinations; codes are single-use, expire in
 * minutes and redemption is rate-limited, so guessing is not practical.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export function generateAccessCode(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accepts what people type: lower case, spaces, dashes, and the usual look-alikes (O→0 is not in the alphabet, so O is invalid). */
export function normalizeAccessCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}
