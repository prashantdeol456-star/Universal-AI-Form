#!/usr/bin/env node
/**
 * Local PostgreSQL 16 for development WITHOUT Docker (handy on Windows).
 * Data persists in ./.data/postgres. Stop with Ctrl+C.
 *
 *   npm run dev:db
 *
 * Uses DATABASE_URL from .env for user/password/port/database name.
 * With Docker available, `npm run dev:services` (docker-compose.dev.yml) is the alternative.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));

const url = new URL(process.env.DATABASE_URL ?? "postgres://ufa_owner:ufa_owner_dev_password@localhost:5432/ufa");
const dataDir = path.join(root, ".data", "postgres");
const fresh = !existsSync(path.join(dataDir, "PG_VERSION"));

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  // Hindi/Devanagari text requires UTF-8 (Windows would otherwise default to WIN1252).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

if (fresh) await pg.initialise();
await pg.start();
const dbName = url.pathname.slice(1);
if (fresh) await pg.createDatabase(dbName);
console.info(`PostgreSQL 16 running on port ${url.port || 5432} (database "${dbName}", data in .data/postgres). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
