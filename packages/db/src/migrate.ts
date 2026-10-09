import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "./client";

export const APP_ROLE = "ufa_app";

export interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: Date;
  checksumMismatch?: boolean;
}

async function loadMigrations(dir: string) {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

async function ensureBookkeeping(sql: Sql) {
  await sql`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )`;
}

/**
 * Creates (or updates the password of) the restricted runtime role.
 * Requires the owner connection to have CREATEROLE (true for the Docker postgres superuser).
 */
export async function ensureAppRole(sql: Sql, password: string) {
  if (!/^[A-Za-z0-9_\-+=/.]{16,128}$/.test(password)) {
    throw new Error("DB_APP_PASSWORD must be 16-128 chars of [A-Za-z0-9_-+=/.]");
  }
  const [row] = await sql`select 1 as x from pg_roles where rolname = ${APP_ROLE}`;
  // Role names/passwords cannot be bound as parameters in DDL; both are validated above.
  if (!row) {
    await sql.unsafe(`create role ${APP_ROLE} login nosuperuser nocreatedb nocreaterole nobypassrls password '${password}'`);
  } else {
    await sql.unsafe(`alter role ${APP_ROLE} with login nobypassrls password '${password}'`);
  }
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  await sql.unsafe(`grant connect on database "${db.replace(/"/g, "")}" to ${APP_ROLE}`);
}

export async function migrationStatus(sql: Sql, dir: string): Promise<MigrationStatus[]> {
  await ensureBookkeeping(sql);
  const applied = new Map(
    (await sql<{ name: string; checksum: string; applied_at: Date }[]>`select name, checksum, applied_at from schema_migrations`).map(
      (r) => [r.name, r],
    ),
  );
  return (await loadMigrations(dir)).map((m) => {
    const a = applied.get(m.name);
    return a
      ? { name: m.name, applied: true, appliedAt: a.applied_at, checksumMismatch: a.checksum !== m.checksum }
      : { name: m.name, applied: false };
  });
}

/** Applies pending migrations, each in its own transaction. Refuses to run if an applied file was edited. */
export async function migrate(pool: Sql, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  // Names, addresses and chat are often in Hindi: refuse to run on a non-UTF-8 database.
  const [{ server_encoding: encoding }] = (await pool`show server_encoding`) as unknown as [{ server_encoding: string }];
  if (encoding.toUpperCase() !== "UTF8") {
    throw new Error(`Database encoding is ${encoding}; UTF8 is required. Recreate the database with ENCODING 'UTF8' (the Docker image does this by default).`);
  }
  // Advisory locks are per-connection, so pin one connection for the whole run.
  const sql = await pool.reserve();
  await ensureBookkeeping(sql);
  // Serialize concurrent migrators (e.g. two containers starting at once).
  await sql`select pg_advisory_lock(726354)`;
  try {
    const status = await migrationStatus(sql, dir);
    const edited = status.filter((s) => s.checksumMismatch);
    if (edited.length) {
      throw new Error(`Applied migrations were modified: ${edited.map((e) => e.name).join(", ")}. Create a new migration instead.`);
    }
    const all = await loadMigrations(dir);
    const pending = all.filter((m) => !status.find((s) => s.name === m.name)?.applied);
    for (const m of pending) {
      log(`Applying ${m.name}`);
      // Explicit BEGIN/COMMIT: allowed on a reserved connection, keeps the lock holder.
      await sql`begin`;
      try {
        await sql.unsafe(m.sql);
        await sql`insert into schema_migrations (name, checksum) values (${m.name}, ${m.checksum})`;
        await sql`commit`;
      } catch (err) {
        await sql`rollback`;
        throw new Error(`Migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return pending.map((m) => m.name);
  } finally {
    await sql`select pg_advisory_unlock(726354)`;
    sql.release();
  }
}
