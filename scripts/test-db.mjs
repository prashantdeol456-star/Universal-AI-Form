#!/usr/bin/env node
/**
 * Runs the database integration tests against a throwaway PostgreSQL 16
 * (embedded-postgres binaries from npm) — no Docker required.
 *
 *   npm run test:db
 *
 * If TEST_DATABASE_URL is already set, the embedded server is skipped and the
 * tests run against that database instead (e.g. the docker-compose.dev.yml one).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_PASSWORD = "test_app_password_1234";
const PORT = Number(process.env.TEST_PG_PORT ?? 54329);

function runVitest(env) {
  return new Promise((resolve) => {
    const child = spawn("npx vitest run --project db", { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (process.env.TEST_DATABASE_URL) {
  process.exit(await runVitest({}));
}

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const dir = await mkdtemp(path.join(tmpdir(), "ufa-pg-"));
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "ufa_owner",
  password: "owner_password_for_tests",
  port: PORT,
  persistent: false,
  // Hindi/Devanagari text requires UTF-8 (Windows would otherwise default to WIN1252).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("ufa_test");
  code = await runVitest({
    TEST_DATABASE_URL: `postgres://ufa_owner:owner_password_for_tests@127.0.0.1:${PORT}/ufa_test`,
    TEST_DATABASE_APP_URL: `postgres://ufa_app:${APP_PASSWORD}@127.0.0.1:${PORT}/ufa_test`,
    TEST_DB_APP_PASSWORD: APP_PASSWORD,
  });
} catch (err) {
  console.error(err);
} finally {
  await pg.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(code);
