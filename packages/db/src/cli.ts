/**
 * Database CLI
 *   tsx packages/db/src/cli.ts migrate        apply pending migrations (creates ufa_app role)
 *   tsx packages/db/src/cli.ts status         list migrations
 *   tsx packages/db/src/cli.ts create-admin   create/promote a SUPER_ADMIN (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { hashPassword } from "@ufa/security";
import { ensureAppRole, migrate, migrationStatus } from "./migrate";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.join(repoRoot, "database/migrations");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const cmd = process.argv[2];
  const sql = postgres(required("DATABASE_URL"), { max: 2, onnotice: () => {} });
  try {
    switch (cmd) {
      case "migrate": {
        await ensureAppRole(sql, required("DB_APP_PASSWORD"));
        const applied = await migrate(sql, MIGRATIONS_DIR, (m) => console.log(m));
        console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is up to date.");
        break;
      }
      case "status": {
        for (const s of await migrationStatus(sql, MIGRATIONS_DIR)) {
          const flag = s.checksumMismatch ? " (MODIFIED AFTER APPLY!)" : "";
          console.log(`${s.applied ? "[x]" : "[ ]"} ${s.name}${flag}`);
        }
        break;
      }
      case "create-admin": {
        const email = required("ADMIN_EMAIL").trim().toLowerCase();
        const password = required("ADMIN_PASSWORD");
        if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
        const name = process.env.ADMIN_NAME ?? "Administrator";
        const hash = await hashPassword(password);
        const [user] = await sql<{ id: string }[]>`
          insert into users (email, full_name, password_hash, role, email_verified_at)
          values (${email}, ${name}, ${hash}, 'SUPER_ADMIN', now())
          on conflict (email) do update set role = 'SUPER_ADMIN', password_hash = excluded.password_hash
          returning id`;
        await sql`insert into profiles (user_id) values (${user!.id}) on conflict do nothing`;
        await sql`insert into audit_logs (actor_id, actor_role, action, target_type, target_id, subject_user_id)
                  values (null, 'SYSTEM', 'admin.created_via_cli', 'user', ${user!.id}, ${user!.id})`;
        console.log(`SUPER_ADMIN ready: ${email}`);
        break;
      }
      default:
        console.log("Usage: cli.ts <migrate|status|create-admin>");
        process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
