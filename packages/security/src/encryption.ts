import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption for sensitive values (Aadhaar, PAN, bank, ...).
 * AES-256-GCM with a random 96-bit IV per value.
 *
 * Ciphertext format: `enc:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>`
 *
 * Keys are supplied as `DATA_ENCRYPTION_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"`.
 * The FIRST key encrypts; all keys can decrypt, which allows key rotation:
 * add a new key at the front, re-encrypt in a background job, then drop the old key.
 */
export interface Keyring {
  primaryId: string;
  keys: Map<string, Buffer>;
}

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<string, Buffer>();
  let primaryId: string | undefined;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("DATA_ENCRYPTION_KEYS entries must look like id:base64key");
    const id = part.slice(0, idx);
    if (!/^[a-zA-Z0-9_-]{1,16}$/.test(id)) throw new Error(`Invalid encryption key id "${id}"`);
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (base64-encoded)`);
    keys.set(id, key);
    primaryId ??= id;
  }
  if (!primaryId) throw new Error("DATA_ENCRYPTION_KEYS is empty");
  return { primaryId, keys };
}

export function encrypt(keyring: Keyring, plaintext: string): string {
  const key = keyring.keys.get(keyring.primaryId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc", keyring.primaryId, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decrypt(keyring: Keyring, ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 5 || parts[0] !== "enc") throw new Error("Malformed ciphertext");
  const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function isCiphertext(value: string): boolean {
  return value.startsWith("enc:");
}

/**
 * Binary envelope for whole files (uploaded documents at rest):
 *   "UFAE1" | keyIdLen (1 byte) | keyId | iv (12) | tag (16) | ciphertext
 * The key id is authenticated as additional data so it cannot be swapped.
 */
const FILE_MAGIC = Buffer.from("UFAE1");

export function encryptBuffer(keyring: Keyring, plaintext: Buffer): Buffer {
  const key = keyring.keys.get(keyring.primaryId)!;
  const keyId = Buffer.from(keyring.primaryId, "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(keyId);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, Buffer.from([keyId.length]), keyId, iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(keyring: Keyring, envelope: Buffer): Buffer {
  if (envelope.length < FILE_MAGIC.length + 1 + 28 || !envelope.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error("Not an encrypted file envelope");
  }
  let o = FILE_MAGIC.length;
  const idLen = envelope[o]!;
  o += 1;
  const keyId = envelope.subarray(o, o + idLen);
  o += idLen;
  const key = keyring.keys.get(keyId.toString("utf8"));
  if (!key) throw new Error(`Unknown encryption key id "${keyId.toString("utf8")}"`);
  const iv = envelope.subarray(o, o + 12);
  const tag = envelope.subarray(o + 12, o + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(keyId);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(o + 28)), decipher.final()]);
}
