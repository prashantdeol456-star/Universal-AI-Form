import "server-only";
import { createDb, withUser as withUserCtx, type Db, type TransactionSql } from "@ufa/db";
import { decrypt, encrypt, parseKeyring, type Keyring } from "@ufa/security";
import { env } from "./env";

// Survive Next.js dev hot reloads without leaking connection pools.
const g = globalThis as unknown as { __ufaDb?: Db; __ufaKeyring?: Keyring };

export function db(): Db {
  if (!g.__ufaDb) {
    const e = env();
    g.__ufaDb = createDb({ systemUrl: e.DATABASE_URL, appUrl: e.DATABASE_APP_URL, maxConnections: e.DB_POOL_MAX });
  }
  return g.__ufaDb;
}

export interface Actor {
  id: string;
  role: string;
}

/** RLS-enforced transaction as `actor`. Use for every user-scoped read/write. */
export function asUser<T>(actor: Actor, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withUserCtx(db(), { userId: actor.id, role: actor.role }, fn);
}

export function keyring(): Keyring {
  g.__ufaKeyring ??= parseKeyring(env().DATA_ENCRYPTION_KEYS);
  return g.__ufaKeyring;
}

export function encryptValue(plaintext: string): string {
  return encrypt(keyring(), plaintext);
}

export function decryptValue(ciphertext: string): string {
  return decrypt(keyring(), ciphertext);
}
