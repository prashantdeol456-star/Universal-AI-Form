#!/usr/bin/env node
/**
 * Prints fresh random secrets for .env. Nothing is written to disk.
 *   npm run gen:secrets
 */
import { randomBytes } from "node:crypto";

const alnum = (n) => randomBytes(n).toString("base64url").replace(/[-_]/g, "").slice(0, n);

console.log(`# Paste into .env (and keep a secure offline copy of DATA_ENCRYPTION_KEYS)
POSTGRES_PASSWORD=${alnum(32)}
DB_APP_PASSWORD=${alnum(32)}
AUTH_SECRET=${randomBytes(48).toString("base64url")}
DATA_ENCRYPTION_KEYS=k1:${randomBytes(32).toString("base64")}`);
