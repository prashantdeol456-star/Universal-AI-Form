/**
 * Job discovery and tracking (migration 0019) against a real PostgreSQL: RLS isolation,
 * same-owner references, de-duplication, "applied" only with the user's confirmation,
 * append-only history, data rules (https, salary with a source). Synthetic data only.
 * Run with `npm run test:db`.
 */
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ensureAppRole, migrate, withUser, type Db } from "../../packages/db/src";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_APP_URL;
const APP_PASSWORD = process.env.TEST_DB_APP_PASSWORD ?? "test_app_password_1234";
const MIGRATIONS = path.resolve(__dirname, "../migrations");
const run = OWNER_URL && APP_URL ? describe : describe.skip;

run("jobs (0019)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const as = <T>(key: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role: "CUSTOMER" }, fn);
  let aliceJob = "";
  let aliceApp = "";

  async function createUser(key: string) {
    const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${key}@jobs.test`}, ${key}, 'x', 'CUSTOMER') returning id`;
    ids[key] = u!.id;
  }
  const insertJob = (key: string, url: string, extra: { provider?: string | null } = {}) =>
    as(key, (tx) => tx<{ id: string }[]>`
      insert into job_listings (user_id, source_type, source_key, provider_job_id, title, employer, canonical_url, required_skills)
      values (${ids[key]!}, 'greenhouse', 'acme', ${extra.provider ?? null}, 'Project Manager', 'Acme', ${url}, ${["Jira"]}::text[])
      returning id`);

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });
    for (const k of ["j_alice", "j_bob"]) await createUser(k);
    aliceJob = (await insertJob("j_alice", "https://boards.greenhouse.io/acme/jobs/1", { provider: "1" }))[0]!.id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it("listings, saves, matches and applications are visible to their owner only", async () => {
    await as("j_alice", (tx) => tx`insert into job_saves (user_id, job_id, notes, shortlisted) values (${ids.j_alice!}, ${aliceJob}, 'call recruiter', true)`);
    await as("j_alice", (tx) => tx`insert into job_matches (job_id, user_id, score, provisional, explanation) values (${aliceJob}, ${ids.j_alice!}, 72, false, ${{ factors: [] } as never})`);
    expect(await as("j_bob", (tx) => tx`select id from job_listings`)).toHaveLength(0);
    expect(await as("j_bob", (tx) => tx`select job_id from job_saves`)).toHaveLength(0);
    expect(await as("j_bob", (tx) => tx`select job_id from job_matches`)).toHaveLength(0);
    expect(await as("j_bob", (tx) => tx`update job_listings set title = 'hacked' returning id`)).toHaveLength(0);
    expect(await as("j_bob", (tx) => tx`delete from job_listings returning id`)).toHaveLength(0);
    await expect(as("j_bob", (tx) => tx`insert into job_listings (user_id, source_type, title, canonical_url) values (${ids.j_alice!}, 'manual', 'x', 'https://x.example.com/j')`)).rejects.toThrow(/row-level security/);
    expect(await as("j_alice", (tx) => tx`select id from job_listings`)).toHaveLength(1);
  });

  it("nobody can attach their rows to another user's job", async () => {
    await expect(as("j_bob", (tx) => tx`insert into job_saves (user_id, job_id) values (${ids.j_bob!}, ${aliceJob})`)).rejects.toThrow(/another user/);
    await expect(as("j_bob", (tx) => tx`insert into job_applications (user_id, job_id, title) values (${ids.j_bob!}, ${aliceJob}, 'PM')`)).rejects.toThrow(/another user/);
    await expect(as("j_bob", (tx) => tx`insert into job_matches (job_id, user_id, score, provisional, explanation) values (${aliceJob}, ${ids.j_bob!}, 99, false, '{}'::jsonb)`)).rejects.toThrow(/another user/);
  });

  it("de-duplicates by provider id and by canonical URL, per user", async () => {
    await expect(insertJob("j_alice", "https://boards.greenhouse.io/acme/jobs/1")).rejects.toThrow(/duplicate key/);
    await expect(insertJob("j_alice", "https://boards.greenhouse.io/acme/jobs/1-other-url", { provider: "1" })).rejects.toThrow(/duplicate key/);
    // Another user may track the same public job.
    expect(await insertJob("j_bob", "https://boards.greenhouse.io/acme/jobs/1", { provider: "1" })).toHaveLength(1);
  });

  it("enforces https links and salaries only with a named source", async () => {
    await expect(insertJob("j_alice", "http://insecure.example.com/job")).rejects.toThrow(/check constraint/);
    await expect(insertJob("j_alice", "javascript:alert(1)")).rejects.toThrow(/check constraint/);
    await expect(
      as("j_alice", (tx) => tx`insert into job_listings (user_id, source_type, title, canonical_url, salary_min, salary_currency) values (${ids.j_alice!}, 'manual', 'x', 'https://x.example.com/s', 100, 'INR')`),
    ).rejects.toThrow(/check constraint/);
    await expect(as("j_alice", (tx) => tx`insert into job_preferences (user_id, work_arrangements) values (${ids.j_alice!}, ${["remote", "moon"]}::text[])`)).rejects.toThrow(/check constraint/);
  });

  it("an application can only be 'applied' (or later) after the user confirmed submitting it", async () => {
    const [a] = await as("j_alice", (tx) => tx<{ id: string }[]>`insert into job_applications (user_id, job_id, title, status) values (${ids.j_alice!}, ${aliceJob}, 'Project Manager', 'preparing') returning id`);
    aliceApp = a!.id;
    await expect(as("j_alice", (tx) => tx`update job_applications set status = 'applied' where id = ${aliceApp}`)).rejects.toThrow(/check constraint/);
    await expect(as("j_alice", (tx) => tx`update job_applications set status = 'interview' where id = ${aliceApp}`)).rejects.toThrow(/check constraint/);
    await as("j_alice", (tx) => tx`update job_applications set status = 'applied', submitted_confirmed_at = now() where id = ${aliceApp}`);
    await expect(as("j_alice", (tx) => tx`insert into job_applications (user_id, job_id, title) values (${ids.j_alice!}, ${aliceJob}, 'again')`)).rejects.toThrow(/duplicate key/);
    await expect(as("j_alice", (tx) => tx`update job_applications set status = 'submitted_by_ai' where id = ${aliceApp}`)).rejects.toThrow(/check constraint/);
  });

  it("history is append-only and owner-bound", async () => {
    await as("j_alice", (tx) => tx`insert into job_application_events (user_id, application_id, kind, from_status, to_status) values (${ids.j_alice!}, ${aliceApp}, 'status', 'preparing', 'applied')`);
    await expect(as("j_alice", (tx) => tx`update job_application_events set to_status = 'offer'`)).rejects.toThrow(/permission denied/);
    await expect(as("j_alice", (tx) => tx`delete from job_application_events`)).rejects.toThrow(/permission denied/);
    await expect(as("j_bob", (tx) => tx`insert into job_application_events (user_id, application_id, kind) values (${ids.j_bob!}, ${aliceApp}, 'notes')`)).rejects.toThrow(/another user/);
    expect(await as("j_bob", (tx) => tx`select id from job_application_events`)).toHaveLength(0);
  });

  it("removing a listing keeps the application as the user's own reference", async () => {
    await as("j_alice", (tx) => tx`delete from job_listings where id = ${aliceJob}`);
    const [app] = await as("j_alice", (tx) => tx<{ job_id: string | null; title: string; status: string }[]>`select job_id, title, status from job_applications where id = ${aliceApp}`);
    expect(app).toEqual({ job_id: null, title: "Project Manager", status: "applied" });
    expect(await as("j_alice", (tx) => tx`select job_id from job_saves`)).toHaveLength(0);
  });
});
