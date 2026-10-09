import "server-only";
import path from "node:path";
import { EncryptedStorage, LocalDiskStorage, type StorageProvider } from "@ufa/storage";
import { keyring } from "./db";
import { env } from "./env";

const g = globalThis as unknown as { __ufaStorage?: StorageProvider };

/** Document storage: local disk (Docker volume on the VPS), encrypted at rest with DATA_ENCRYPTION_KEYS. */
export function storage(): StorageProvider {
  g.__ufaStorage ??= new EncryptedStorage(new LocalDiskStorage(path.resolve(env().STORAGE_LOCAL_DIR)), keyring());
  return g.__ufaStorage;
}
