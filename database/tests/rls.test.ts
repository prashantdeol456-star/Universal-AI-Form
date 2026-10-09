/**
 * Integration tests for migrations + Row Level Security against a real PostgreSQL.
 *
 * Run with `npm run test:db` (starts a throwaway embedded PostgreSQL 16), or point
 * TEST_DATABASE_URL (owner) / TEST_DATABASE_APP_URL (ufa_app) at an EMPTY database.
 */
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLearning } from "../../packages/ai/src/learning/run";
import { createDb, ensureAppRole, eraseUser, migrate, migrationStatus, withUser, type Db } from "../../packages/db/src";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_APP_URL;
const APP_PASSWORD = process.env.TEST_DB_APP_PASSWORD ?? "test_app_password_1234";
const MIGRATIONS = path.resolve(__dirname, "../migrations");

const run = OWNER_URL && APP_URL ? describe : describe.skip;

run("database: migrations and row level security", () => {
  let db: Db;
  const ids: Record<string, string> = {};

  async function createUser(key: string, role = "CUSTOMER") {
    const [u] = await db.system<{ id: string }[]>`
      insert into users (email, full_name, password_hash, role)
      values (${`${key}@test.local`}, ${key}, 'x', ${role}) returning id`;
    ids[key] = u!.id;
    return u!.id;
  }

  const as = <T>(key: string, role: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role }, fn);

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });

    await createUser("alice");
    await createUser("bob");
    await createUser("owner", "CAFE_OWNER");
    await createUser("operator", "CAFE_OPERATOR");
    await createUser("admin", "SUPER_ADMIN");
  });

  afterAll(async () => {
    await db?.close();
  });

  it("applies every migration exactly once and is idempotent", async () => {
    const status = await migrationStatus(db.system, MIGRATIONS);
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((s) => s.applied && !s.checksumMismatch)).toBe(true);
    expect(await migrate(db.system, MIGRATIONS)).toEqual([]);
  });

  it("stores Hindi (Devanagari) text — database must be UTF-8", async () => {
    const [{ v }] = (await db.system`select ${"राज कुमार"}::text as v`) as unknown as [{ v: string }];
    expect(v).toBe("राज कुमार");
  });

  it("runtime role is not a superuser and cannot bypass RLS", async () => {
    const [r] = await db.app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("isolates profile data between customers", async () => {
    await as("alice", "CUSTOMER", (tx) => tx`
      insert into profile_fields (user_id, field_key, value, source, verified)
      values (${ids.alice!}, 'family.father_name', 'Raj Kumar', 'user_input', true)`);

    const seenByBob = await as("bob", "CUSTOMER", (tx) => tx`select * from profile_fields where field_key = 'family.father_name'`);
    expect(seenByBob).toHaveLength(0);

    const updated = await as("bob", "CUSTOMER", (tx) => tx`update profile_fields set value = 'hacked' where user_id = ${ids.alice!} returning id`);
    expect(updated).toHaveLength(0);

    await expect(
      as("bob", "CUSTOMER", (tx) => tx`
        insert into profile_fields (user_id, field_key, value, source) values (${ids.alice!}, 'family.mother_name', 'x', 'user_input')`),
    ).rejects.toThrow(/row-level security/);

    const own = await as("alice", "CUSTOMER", (tx) => tx`select value from profile_fields where field_key = 'family.father_name'`);
    expect(own).toEqual([{ value: "Raj Kumar" }]);
  });

  it("returns nothing when no user context is set", async () => {
    expect(await db.app`select * from profile_fields`).toHaveLength(0);
  });

  it("hides credentials and privileged columns from the runtime role", async () => {
    await expect(as("alice", "CUSTOMER", (tx) => tx`select password_hash from users where id = ${ids.alice!}`)).rejects.toThrow(/permission denied/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`select * from auth_tokens`)).rejects.toThrow(/permission denied/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update users set role = 'SUPER_ADMIN' where id = ${ids.alice!}`)).rejects.toThrow(/permission denied/);
    // Allowed: own non-privileged columns.
    const r = await as("alice", "CUSTOMER", (tx) => tx`update users set full_name = 'Alice K' where id = ${ids.alice!} returning id`);
    expect(r).toHaveLength(1);
  });

  it("does not let a super admin read customer profile values", async () => {
    const rows = await as("admin", "SUPER_ADMIN", (tx) => tx`select * from profile_fields where user_id = ${ids.alice!}`);
    expect(rows).toHaveLength(0);
  });

  describe("café access sessions", () => {
    let cafeId: string;
    let sessionId: string;

    beforeAll(async () => {
      const [cafe] = await as("owner", "CAFE_OWNER", (tx) => tx<{ id: string }[]>`
        insert into cafes (name, owner_id) values ('ABC Cyber Cafe', ${ids.owner!}) returning id`);
      cafeId = cafe!.id;
      await as("owner", "CAFE_OWNER", (tx) => tx`
        insert into cafe_users (cafe_id, user_id, cafe_role) values (${cafeId}, ${ids.owner!}, 'OWNER'), (${cafeId}, ${ids.operator!}, 'OPERATOR')`);
      await as("alice", "CUSTOMER", (tx) => tx`
        insert into profile_fields (user_id, field_key, value, source) values
          (${ids.alice!}, 'contact.mobile', '9876543210', 'user_input'),
          (${ids.alice!}, 'bank.account_number', 'enc:k1:x:y:z', 'user_input')`);
    });

    const operatorReads = () =>
      as("operator", "CAFE_OPERATOR", (tx) => tx<{ field_key: string }[]>`
        select field_key from profile_fields where user_id = ${ids.alice!} order by field_key`);

    it("a customer cannot open a café as a non-café-owner", async () => {
      await expect(as("alice", "CUSTOMER", (tx) => tx`insert into cafes (name, owner_id) values ('Fake', ${ids.alice!})`)).rejects.toThrow(/row-level security/);
    });

    it("operator sees nothing without a session", async () => {
      expect(await operatorReads()).toEqual([]);
    });

    it("operator can request but not self-approve a session", async () => {
      const [s] = await as("operator", "CAFE_OPERATOR", (tx) => tx<{ id: string }[]>`
        insert into cafe_sessions (cafe_id, customer_id, operator_id, purpose, expires_at)
        values (${cafeId}, ${ids.alice!}, ${ids.operator!}, 'SSC form', now() + interval '1 hour') returning id`);
      sessionId = s!.id;
      await as("operator", "CAFE_OPERATOR", (tx) => tx`
        insert into cafe_permissions (cafe_session_id, permission) values (${sessionId}, 'family')`);

      await expect(
        as("operator", "CAFE_OPERATOR", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now() where id = ${sessionId}`),
      ).rejects.toThrow(/row-level security/);
      expect(await operatorReads()).toEqual([]);
    });

    it("bank is not a grantable permission", async () => {
      await expect(
        as("operator", "CAFE_OPERATOR", (tx) => tx`insert into cafe_permissions (cafe_session_id, permission) values (${sessionId}, 'bank')`),
      ).rejects.toThrow(/check constraint/);
    });

    it("after customer approval the operator reads only the granted category", async () => {
      await as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now() where id = ${sessionId}`);
      expect(await operatorReads()).toEqual([{ field_key: "family.father_name" }]);
      // Operator still cannot write customer data.
      const w = await as("operator", "CAFE_OPERATOR", (tx) => tx`update profile_fields set value = 'x' where user_id = ${ids.alice!} returning id`);
      expect(w).toHaveLength(0);
    });

    it("permissions are frozen once the session is active", async () => {
      await expect(
        as("operator", "CAFE_OPERATOR", (tx) => tx`insert into cafe_permissions (cafe_session_id, permission) values (${sessionId}, 'contact')`),
      ).rejects.toThrow(/row-level security/);
    });

    it("another customer is never visible through the session", async () => {
      await as("bob", "CUSTOMER", (tx) => tx`
        insert into profile_fields (user_id, field_key, value, source) values (${ids.bob!}, 'family.father_name', 'Bob Sr', 'user_input')`);
      const rows = await as("operator", "CAFE_OPERATOR", (tx) => tx`select 1 from profile_fields where user_id = ${ids.bob!}`);
      expect(rows).toHaveLength(0);
    });

    it("customer revocation removes access immediately", async () => {
      await as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'REVOKED', revoked_at = now(), revoked_by = ${ids.alice!} where id = ${sessionId}`);
      expect(await operatorReads()).toEqual([]);
    });

    it("a closed session can never be re-opened (0010)", async () => {
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', revoked_at = null, expires_at = now() + interval '1 hour' where id = ${sessionId}`),
      ).rejects.toThrow(/invalid café session change/);
    });

    it("sessions last at most 12 hours, can only be shortened, and expired sessions grant nothing (0010)", async () => {
      const request = () =>
        as("operator", "CAFE_OPERATOR", async (tx) => {
          const [s] = await tx<{ id: string }[]>`
            insert into cafe_sessions (cafe_id, customer_id, operator_id, expires_at)
            values (${cafeId}, ${ids.alice!}, ${ids.operator!}, now() + interval '1 hour') returning id`;
          await tx`insert into cafe_permissions (cafe_session_id, permission) values (${s!.id}, 'family')`;
          return s!.id;
        });
      const s2 = await request();
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now(), expires_at = now() + interval '2 days' where id = ${s2}`),
      ).rejects.toThrow(/12 hours/);
      await as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now(), expires_at = now() + interval '2 hours' where id = ${s2}`);
      expect(await operatorReads()).toEqual([{ field_key: "family.father_name" }]);
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set expires_at = now() + interval '5 hours' where id = ${s2}`),
      ).rejects.toThrow(/never extended/);
      // Operator cannot swap the customer of a session.
      await expect(as("operator", "CAFE_OPERATOR", (tx) => tx`update cafe_sessions set customer_id = ${ids.bob!} where id = ${s2}`)).rejects.toThrow(/permission denied/);
      // Time passes (simulated by shortening): access ends by itself.
      await db.system`update cafe_sessions set expires_at = now() - interval '1 minute' where id = ${s2}`;
      expect(await operatorReads()).toEqual([]);
    });

    it("café sees filled values only while the session allows it (0010)", async () => {
      const s3 = await as("operator", "CAFE_OPERATOR", async (tx) => {
        const [s] = await tx<{ id: string }[]>`
          insert into cafe_sessions (cafe_id, customer_id, operator_id, expires_at)
          values (${cafeId}, ${ids.alice!}, ${ids.operator!}, now() + interval '1 hour') returning id`;
        await tx`insert into cafe_permissions (cafe_session_id, permission) values (${s!.id}, 'applications'), (${s!.id}, 'family')`;
        return s!.id;
      });
      await as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now(), expires_at = now() + interval '1 hour' where id = ${s3}`);
      const [app] = await as("operator", "CAFE_OPERATOR", (tx) => tx<{ id: string }[]>`
        insert into applications (customer_id, operator_id, cafe_id, cafe_session_id, website_url, domain, status)
        values (${ids.alice!}, ${ids.operator!}, ${cafeId}, ${s3}, 'https://x.gov.in/f', 'x.gov.in', 'IN_PROGRESS') returning id`);
      await as("operator", "CAFE_OPERATOR", (tx) => tx`insert into application_fields (application_id, website_field_label, field_value) values (${app!.id}, 'Father', 'enc:secret')`);
      const seen = () => as("operator", "CAFE_OPERATOR", (tx) => tx`select field_value from application_fields where application_id = ${app!.id}`);
      expect(await seen()).toHaveLength(1);
      await as("alice", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'REVOKED', revoked_by = ${ids.alice!} where id = ${s3}`);
      expect(await seen()).toHaveLength(0);
      // The application itself (metadata) stays visible to the café; the customer sees everything.
      expect(await as("operator", "CAFE_OPERATOR", (tx) => tx`select 1 from applications where id = ${app!.id}`)).toHaveLength(1);
      expect(await as("alice", "CUSTOMER", (tx) => tx`select 1 from application_fields where application_id = ${app!.id}`)).toHaveLength(1);
      expect(await as("owner", "CAFE_OWNER", (tx) => tx`select 1 from application_fields where application_id = ${app!.id}`)).toHaveLength(0);
    });

    it("access codes are private to the customer and short-lived (0010)", async () => {
      await as("alice", "CUSTOMER", (tx) => tx`
        insert into cafe_access_codes (customer_id, code_hash, permissions, duration_minutes, expires_at)
        values (${ids.alice!}, 'h-alice-1', ${["family", "applications"]}, 60, now() + interval '15 minutes')`);
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`
          insert into cafe_access_codes (customer_id, code_hash, permissions, duration_minutes, expires_at)
          values (${ids.alice!}, 'h-alice-2', ${["bank"]}, 60, now() + interval '15 minutes')`),
      ).rejects.toThrow(/check constraint/);
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`
          insert into cafe_access_codes (customer_id, code_hash, permissions, duration_minutes, expires_at)
          values (${ids.alice!}, 'h-alice-3', ${["family"]}, 60, now() + interval '1 day')`),
      ).rejects.toThrow(/row-level security/);
      expect(await as("operator", "CAFE_OPERATOR", (tx) => tx`select 1 from cafe_access_codes`)).toHaveLength(0);
      await expect(as("alice", "CUSTOMER", (tx) => tx`update cafe_access_codes set used_at = now()`)).rejects.toThrow(/permission denied/);
    });
  });

  it("makes confirmed application snapshots immutable", async () => {
    const [app] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into applications (customer_id, website_url, domain, form_name, status)
      values (${ids.alice!}, 'https://example.gov.in/apply', 'example.gov.in', 'Recruitment', 'IN_PROGRESS') returning id`);
    await as("alice", "CUSTOMER", (tx) => tx`
      insert into application_fields (application_id, website_field_label, field_value, profile_field_key)
      values (${app!.id}, 'Father''s Name', 'Raj Kumar', 'family.father_name')`);
    await as("alice", "CUSTOMER", (tx) => tx`update applications set status = 'CONFIRMED', confirmed_at = now() where id = ${app!.id}`);

    // Profile changes later; the snapshot must not.
    await as("alice", "CUSTOMER", (tx) => tx`update profile_fields set value = 'Rajesh Kumar' where user_id = ${ids.alice!} and field_key = 'family.father_name'`);
    const [snap] = await as("alice", "CUSTOMER", (tx) => tx<{ field_value: string }[]>`select field_value from application_fields where application_id = ${app!.id}`);
    expect(snap!.field_value).toBe("Raj Kumar");

    await expect(db.system`update application_fields set field_value = 'x' where application_id = ${app!.id}`).rejects.toThrow(/immutable/);
    await expect(
      as("alice", "CUSTOMER", (tx) => tx`insert into application_fields (application_id, website_field_label) values (${app!.id}, 'late')`),
    ).rejects.toThrow(/immutable/);

    const bobSees = await as("bob", "CUSTOMER", (tx) => tx`select 1 from application_fields where application_id = ${app!.id}`);
    expect(bobSees).toHaveLength(0);

    // 0006: where/what was applied for is fixed; only allowed status changes.
    await expect(as("alice", "CUSTOMER", (tx) => tx`update applications set website_url = 'https://evil.example' where id = ${app!.id}`)).rejects.toThrow(/permission denied/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update applications set status = 'DRAFT' where id = ${app!.id}`)).rejects.toThrow(/invalid application status/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update applications set confirmed_at = now() - interval '1 day' where id = ${app!.id}`)).rejects.toThrow(/confirmed_at/);
    await as("alice", "CUSTOMER", (tx) => tx`update applications set status = 'SUBMITTED', submitted_at = now(), application_number = 'REG-1' where id = ${app!.id}`);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update applications set status = 'CONFIRMED' where id = ${app!.id}`)).rejects.toThrow(/invalid application status/);
    const bobUpdates = await as("bob", "CUSTOMER", (tx) => tx`update applications set application_number = 'x' where id = ${app!.id} returning id`);
    expect(bobUpdates).toHaveLength(0);
  });

  describe("document pipeline (0003)", () => {
    let docId: string;

    it("lets a user insert only an unprocessed, unscanned document", async () => {
      const [d] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
        insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256)
        values (${ids.alice!}, 'aadhaar', 'users/a/1.png', 'a.png', 'image/png', 10, 'h1') returning id`);
      docId = d!.id;
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`
          insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256, status, scan_status)
          values (${ids.alice!}, 'pan', 'users/a/2.png', 'b.png', 'image/png', 10, 'h2', 'EXTRACTED', 'CLEAN')`),
      ).rejects.toThrow(/row-level security/);
    });

    it("does not let users mark documents processed or invent extractions", async () => {
      await expect(as("alice", "CUSTOMER", (tx) => tx`update documents set status = 'VERIFIED' where id = ${docId}`)).rejects.toThrow(/permission denied/);
      await expect(as("alice", "CUSTOMER", (tx) => tx`update documents set scan_status = 'CLEAN' where id = ${docId}`)).rejects.toThrow(/permission denied/);
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`
          insert into document_extractions (document_id, user_id, field_key, extracted_value) values (${docId}, ${ids.alice!}, 'personal.gender', 'Male')`),
      ).rejects.toThrow(/permission denied/);
      // Allowed: soft delete own document.
      const r = await as("alice", "CUSTOMER", (tx) => tx`update documents set title = 'Front side' where id = ${docId} returning id`);
      expect(r).toHaveLength(1);
    });

    it("isolates extractions and conflicts between users, and allows one open conflict per field", async () => {
      // The worker (system pool) writes extractions and conflicts.
      await db.system`insert into document_extractions (document_id, user_id, field_key, extracted_value, confidence)
                      values (${docId}, ${ids.alice!}, 'personal.date_of_birth', '2001-05-12', 0.9)`;
      await db.system`insert into document_conflicts (user_id, field_key, candidates) values (${ids.alice!}, 'personal.date_of_birth', '[]')`;
      await expect(
        db.system`insert into document_conflicts (user_id, field_key, candidates) values (${ids.alice!}, 'personal.date_of_birth', '[]')`,
      ).rejects.toThrow(/document_conflicts_one_open/);

      expect(await as("bob", "CUSTOMER", (tx) => tx`select 1 from document_extractions where document_id = ${docId}`)).toHaveLength(0);
      expect(await as("bob", "CUSTOMER", (tx) => tx`select 1 from document_conflicts where user_id = ${ids.alice!}`)).toHaveLength(0);
      expect(await as("bob", "CUSTOMER", (tx) => tx`select 1 from documents where id = ${docId}`)).toHaveLength(0);

      const reviewed = await as("alice", "CUSTOMER", (tx) => tx`
        update document_extractions set status = 'CONFIRMED', reviewed_at = now() where document_id = ${docId} returning id`);
      expect(reviewed).toHaveLength(1);
      await expect(
        as("alice", "CUSTOMER", (tx) => tx`update document_extractions set extracted_value = 'x' where document_id = ${docId}`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("isolates chat sessions, messages and proposals (0004)", async () => {
    const [s] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into chat_sessions (user_id, title) values (${ids.alice!}, 'hi') returning id`);
    const [m] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into chat_messages (session_id, user_id, role, content) values (${s!.id}, ${ids.alice!}, 'user', 'My father is Raj') returning id`);
    const [p] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into chat_proposals (user_id, session_id, message_id, field_key, value, kind)
      values (${ids.alice!}, ${s!.id}, ${m!.id}, 'family.father_name', 'Raj', 'NEW') returning id`);

    for (const table of ["chat_sessions", "chat_messages", "chat_proposals"]) {
      expect(await as("bob", "CUSTOMER", (tx) => tx.unsafe(`select 1 from ${table} where user_id = $1`, [ids.alice!]))).toHaveLength(0);
    }
    await expect(
      as("bob", "CUSTOMER", (tx) => tx`
        insert into chat_proposals (user_id, session_id, message_id, field_key, value, kind)
        values (${ids.alice!}, ${s!.id}, ${m!.id}, 'family.father_name', 'Evil', 'NEW')`),
    ).rejects.toThrow(/row-level security/);
    // Owner may only change the decision columns, never the proposed value or chat history.
    expect(await as("alice", "CUSTOMER", (tx) => tx`update chat_proposals set status = 'SAVED' where id = ${p!.id} returning id`)).toHaveLength(1);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update chat_proposals set value = 'x' where id = ${p!.id}`)).rejects.toThrow(/permission denied/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update chat_messages set content = 'x' where id = ${m!.id}`)).rejects.toThrow(/permission denied/);
  });

  it("lets users write only their own USER-scope mappings (knowledge base)", async () => {
    const upsert = (who: string, scope: string, userId: string | null, key: string) =>
      as(who, "CUSTOMER", (tx) => tx`
        insert into form_mappings (scope, user_id, domain, field_signature, field_label, normalized_label, profile_field_key, verified, success_count)
        values (${scope}, ${userId}, 'example.gov.in', 'abcd1234', 'Name of Father', 'name of father', ${key}, true, 1)
        on conflict (scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(domain, ''), field_signature, profile_field_key)
        do update set success_count = form_mappings.success_count + 1
        returning success_count`);
    expect(await upsert("alice", "USER", ids.alice!, "family.father_name")).toEqual([{ success_count: 1 }]);
    expect(await upsert("alice", "USER", ids.alice!, "family.father_name")).toEqual([{ success_count: 2 }]);
    await expect(upsert("alice", "GLOBAL", null, "family.father_name")).rejects.toThrow(/row-level security/);
    await expect(upsert("alice", "USER", ids.bob!, "family.father_name")).rejects.toThrow(/row-level security/);
    // Bob cannot see Alice's personal mappings, but everyone can read shared global knowledge.
    await db.system`insert into form_mappings (scope, field_signature, field_label, normalized_label, profile_field_key, verified)
                    values ('GLOBAL', 'name of father', 'Name of Father', 'name of father', 'family.father_name', true)`;
    const bobSees = await as("bob", "CUSTOMER", (tx) => tx<{ scope: string }[]>`select scope from form_mappings where normalized_label = 'name of father'`);
    expect(bobSees.map((r) => r.scope)).toEqual(["GLOBAL"]);
  });

  it("keeps the AI answer cache server-only and AI suggestions private (0005)", async () => {
    await expect(as("alice", "CUSTOMER", (tx) => tx`select * from ai_mapping_cache`)).rejects.toThrow(/permission denied/);
    await db.system`insert into ai_mapping_cache (cache_key, provider, model, profile_field_key, confidence, expires_at)
                    values ('name of father||text|', 'gemini', 'm', 'family.father_name', 0.85, now() + interval '1 day')`;

    const [s] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into ai_field_suggestions (user_id, provider, domain, field_signature, suggested_key, confidence)
      values (${ids.alice!}, 'gemini', 'example.gov.in', 'abcd1234', 'family.guardian_name', 0.8) returning id`);
    expect(await as("bob", "CUSTOMER", (tx) => tx`select 1 from ai_field_suggestions where id = ${s!.id}`)).toHaveLength(0);
    expect(await as("alice", "CUSTOMER", (tx) => tx`update ai_field_suggestions set user_confirmed = true, resolved_at = now() where id = ${s!.id} returning id`)).toHaveLength(1);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update ai_field_suggestions set suggested_key = 'x' where id = ${s!.id}`)).rejects.toThrow(/permission denied/);

    // Cloud-AI preference is the user's own setting. (Signup creates the profiles row; test users need one.)
    await db.system`insert into profiles (user_id) values (${ids.alice!}) on conflict do nothing`;
    expect(await as("alice", "CUSTOMER", (tx) => tx`update profiles set cloud_ai_enabled = false where user_id = ${ids.alice!} returning user_id`)).toHaveLength(1);
    expect(await as("bob", "CUSTOMER", (tx) => tx`update profiles set cloud_ai_enabled = false where user_id = ${ids.alice!} returning user_id`)).toHaveLength(0);
  });

  it("keeps audit logs append-only for the runtime role", async () => {
    await as("alice", "CUSTOMER", (tx) => tx`insert into audit_logs (actor_id, action, subject_user_id) values (${ids.alice!}, 'test.event', ${ids.alice!})`);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update audit_logs set action = 'tampered'`)).rejects.toThrow(/permission denied/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`delete from audit_logs`)).rejects.toThrow(/permission denied/);
    // Cannot forge events as someone else.
    await expect(
      as("alice", "CUSTOMER", (tx) => tx`insert into audit_logs (actor_id, action) values (${ids.bob!}, 'forged')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("links only your own documents to your own applications, and protects saved forms (0007)", async () => {
    const [app] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into applications (customer_id, website_url, domain, status) values (${ids.alice!}, 'https://p.example/a', 'p.example', 'IN_PROGRESS') returning id`);
    const [aliceDoc] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256)
      values (${ids.alice!}, 'photo', 'users/a/p.jpg', 'p.jpg', 'image/jpeg', 10, 'hp') returning id`);
    const [bobDoc] = await as("bob", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256)
      values (${ids.bob!}, 'photo', 'users/b/p.jpg', 'q.jpg', 'image/jpeg', 10, 'hq') returning id`);

    // A guessed document id of another user cannot be linked.
    await expect(
      as("alice", "CUSTOMER", (tx) => tx`insert into application_documents (application_id, document_id) values (${app!.id}, ${bobDoc!.id})`),
    ).rejects.toThrow(/row-level security/);
    await as("alice", "CUSTOMER", (tx) => tx`insert into application_documents (application_id, document_id, website_field_label) values (${app!.id}, ${aliceDoc!.id}, 'Photo')`);
    // Bob can neither see nor remove Alice's link; Alice can.
    const bobDeleted = await as("bob", "CUSTOMER", (tx) => tx`delete from application_documents where application_id = ${app!.id} returning 1`);
    expect(bobDeleted).toHaveLength(0);
    const aliceDeleted = await as("alice", "CUSTOMER", (tx) => tx`delete from application_documents where application_id = ${app!.id} returning 1`);
    expect(aliceDeleted).toHaveLength(1);

    const [sf] = await as("alice", "CUSTOMER", (tx) => tx<{ id: string }[]>`
      insert into saved_forms (user_id, name, url, domain) values (${ids.alice!}, 'Portal', 'https://p.example/a', 'p.example') returning id`);
    await expect(
      as("alice", "CUSTOMER", (tx) => tx`insert into saved_forms (user_id, name, url, domain) values (${ids.alice!}, 'Again', 'https://p.example/a', 'p.example')`),
    ).rejects.toThrow(/duplicate key/);
    await expect(as("alice", "CUSTOMER", (tx) => tx`update saved_forms set url = 'https://evil.example' where id = ${sf!.id}`)).rejects.toThrow(/permission denied/);
    await as("alice", "CUSTOMER", (tx) => tx`update saved_forms set notes = 'fee 100' where id = ${sf!.id}`);
    expect(await as("bob", "CUSTOMER", (tx) => tx`select 1 from saved_forms where id = ${sf!.id}`)).toHaveLength(0);
  });

  it("a suspended café loses customer access immediately (0012)", async () => {
    await createUser("s_owner", "CAFE_OWNER");
    await createUser("s_op", "CAFE_OPERATOR");
    await createUser("s_cust");
    const [cafe] = await as("s_owner", "CAFE_OWNER", (tx) => tx<{ id: string }[]>`insert into cafes (name, owner_id) values ('Suspend Me', ${ids.s_owner!}) returning id`);
    await as("s_owner", "CAFE_OWNER", (tx) => tx`insert into cafe_users (cafe_id, user_id, cafe_role) values (${cafe!.id}, ${ids.s_owner!}, 'OWNER'), (${cafe!.id}, ${ids.s_op!}, 'OPERATOR')`);
    await as("s_cust", "CUSTOMER", (tx) => tx`insert into profile_fields (user_id, field_key, value, source) values (${ids.s_cust!}, 'family.mother_name', 'Sita', 'user_input')`);
    const sid = await as("s_op", "CAFE_OPERATOR", async (tx) => {
      const [x] = await tx<{ id: string }[]>`insert into cafe_sessions (cafe_id, customer_id, operator_id, expires_at) values (${cafe!.id}, ${ids.s_cust!}, ${ids.s_op!}, now() + interval '1 hour') returning id`;
      await tx`insert into cafe_permissions (cafe_session_id, permission) values (${x!.id}, 'family')`;
      return x!.id;
    });
    await as("s_cust", "CUSTOMER", (tx) => tx`update cafe_sessions set status = 'ACTIVE', approved_at = now(), expires_at = now() + interval '1 hour' where id = ${sid}`);
    const reads = () => as("s_op", "CAFE_OPERATOR", (tx) => tx`select field_key from profile_fields where user_id = ${ids.s_cust!}`);
    expect(await reads()).toHaveLength(1);
    await db.system`update cafes set status = 'SUSPENDED' where id = ${cafe!.id}`;
    expect(await reads()).toHaveLength(0);
  });

  it("hardening: MFA secrets unreadable, query timeouts set, full account erasure works (0014)", async () => {
    await expect(as("alice", "CUSTOMER", (tx) => tx`select mfa_totp_secret from users where id = ${ids.alice!}`)).rejects.toThrow(/permission denied/);
    const [t] = await as("alice", "CUSTOMER", (tx) => tx<{ statement_timeout: string }[]>`show statement_timeout`);
    expect(t!.statement_timeout).toBe("15s");

    // A user with everything: profile, document linked to a confirmed application, café session, learning data, a closed café.
    await createUser("eraseme", "CAFE_OWNER");
    await createUser("e_op", "CAFE_OPERATOR");
    const uid = ids.eraseme!;
    await db.system`insert into profiles (user_id) values (${uid})`;
    await db.system`insert into profile_fields (user_id, field_key, value, source) values (${uid}, 'family.father_name', 'X', 'user_input')`;
    const [doc] = await db.system<{ id: string }[]>`
      insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256)
      values (${uid}, 'photo', ${`users/${uid}/p.jpg`}, 'p.jpg', 'image/jpeg', 5, 'h') returning id`;
    const [app] = await db.system<{ id: string }[]>`
      insert into applications (customer_id, website_url, domain, status) values (${uid}, 'https://e.gov.in/a', 'e.gov.in', 'IN_PROGRESS') returning id`;
    await db.system`insert into application_fields (application_id, website_field_label, field_value) values (${app!.id}, 'Father', 'enc:x')`;
    await db.system`insert into application_documents (application_id, document_id) values (${app!.id}, ${doc!.id})`;
    await db.system`update applications set status = 'CONFIRMED', confirmed_at = now() where id = ${app!.id}`;
    const [cafe] = await db.system<{ id: string }[]>`insert into cafes (name, owner_id, status, deleted_at) values ('Closed Cafe', ${uid}, 'CLOSED', now()) returning id`;
    await db.system`insert into cafe_users (cafe_id, user_id, cafe_role) values (${cafe!.id}, ${ids.e_op!}, 'OPERATOR')`;
    await db.system`insert into learning_examples (source, contributor_user_id, field_label, profile_field_key, status) values ('USER_VERIFIED', ${uid}, 'Father', 'family.father_name', 'REMOVED')`;
    await db.system`insert into audit_logs (actor_id, action, subject_user_id) values (${uid}, 'test.before_erasure', ${uid})`;
    await db.system`insert into notifications (user_id, type, title) values (${uid}, 't', 'hi')`;

    const { storageKeys } = await eraseUser(db.system, uid);
    expect(storageKeys).toEqual([`users/${uid}/p.jpg`]);
    const [left] = await db.system<{ n: number }[]>`
      select (select count(*) from users where id = ${uid}) + (select count(*) from profile_fields where user_id = ${uid})
           + (select count(*) from documents where user_id = ${uid}) + (select count(*) from applications where customer_id = ${uid})
           + (select count(*) from application_fields where application_id = ${app!.id}) + (select count(*) from cafes where id = ${cafe!.id})
           + (select count(*) from notifications where user_id = ${uid}) + (select count(*) from learning_examples where contributor_user_id = ${uid}) as n`;
    expect(Number(left!.n)).toBe(0);
    // The audit trail survives without the link to the person.
    const [a] = await db.system<{ actor_id: string | null; subject_user_id: string | null }[]>`select actor_id, subject_user_id from audit_logs where action = 'test.before_erasure'`;
    expect(a).toEqual({ actor_id: null, subject_user_id: null });
    expect(await db.system`select 1 from audit_logs where action = 'privacy.account_deleted'`).toHaveLength(1);
    // Snapshots of other users stay immutable (erasure permission was local to that transaction).
    await expect(db.system`delete from application_fields where application_id in (select id from applications where status = 'SUBMITTED')`).rejects.toThrow(/immutable/);
  });

  it("model registry: one production model, evaluations admin-only, pgvector optional (0011)", async () => {
    const [ds] = await db.system<{ id: string }[]>`
      insert into training_datasets (name, version, status, example_count) values ('t-ds', 1, 'LOCKED', 100) returning id`;
    await db.system`insert into model_versions (name, base_model, dataset_id, status, serving_name) values ('m-a', 'base', ${ds!.id}, 'PRODUCTION', 'ufa:a')`;
    await expect(
      db.system`insert into model_versions (name, base_model, dataset_id, status, serving_name) values ('m-b', 'base', ${ds!.id}, 'PRODUCTION', 'ufa:b')`,
    ).rejects.toThrow(/duplicate key|unique/);
    await db.system`insert into model_evaluations (model_name, dataset_id, metrics) values ('m-a', ${ds!.id}, ${db.system.json({ accuracy: 0.9 })})`;
    expect(await as("alice", "CUSTOMER", (tx) => tx`select 1 from model_evaluations`)).toHaveLength(0);
    expect(await as("alice", "CUSTOMER", (tx) => tx`select 1 from model_versions`)).toHaveLength(0);
    expect(await as("admin", "SUPER_ADMIN", (tx) => tx`select 1 from model_evaluations`)).toHaveLength(1);
    // Without the pgvector extension the migration still applies and simply skips the table.
    const [{ hasVector, hasTable }] = (await db.system`
      select exists (select 1 from pg_available_extensions where name = 'vector') as "hasVector",
             to_regclass('label_embeddings') is not null as "hasTable"`) as unknown as [{ hasVector: boolean; hasTable: boolean }];
    expect(hasTable).toBe(hasVector);
  });

  it("learning: promotes only what several users agree on, respects opt-out, demotes when evidence goes (0009)", async () => {
    const people = ["l1", "l2", "l3"];
    for (const p of people) {
      await createUser(p);
      await db.system`insert into profiles (user_id) values (${ids[p]!}) on conflict do nothing`;
    }
    // l1 and l3 on ssc (same field), l2 on upsc: all say "Father's Name" → father_name.
    const site = (p: string) => (p === "l2" ? { domain: "upsc.gov.in", sig: "bbbb2222" } : { domain: "ssc.gov.in", sig: "aaaa1111" });
    for (const p of people) {
      const s = site(p);
      await as(p, "CUSTOMER", (tx) => tx`
        insert into form_mappings (scope, user_id, domain, field_signature, field_label, normalized_label, profile_field_key, verified, verification_source, success_count)
        values ('USER', ${ids[p]!}, ${s.domain}, ${s.sig}, 'Father''s Name', 'fathers name', 'family.father_name', true, 'user', 1)`);
    }
    // The runtime role can never write shared knowledge itself.
    await expect(
      as("l1", "CUSTOMER", (tx) => tx`
        insert into form_mappings (scope, domain, field_signature, field_label, normalized_label, profile_field_key, verified)
        values ('WEBSITE', 'ssc.gov.in', 'aaaa1111', 'x', 'x', 'family.father_name', true)`),
    ).rejects.toThrow(/row-level security/);

    const r1 = await runLearning(db.system);
    expect(r1).toMatchObject({ skipped: false, websitePromoted: 1, globalPromoted: 1, demoted: 0 });
    const shared = await as("alice", "CUSTOMER", (tx) => tx<{ scope: string; domain: string | null; verified: boolean; success_count: number }[]>`
      select scope, domain, verified, success_count from form_mappings where scope in ('WEBSITE', 'GLOBAL') and normalized_label = 'fathers name' order by scope`);
    expect(shared).toEqual([
      { scope: "GLOBAL", domain: null, verified: true, success_count: 3 },
      { scope: "WEBSITE", domain: "ssc.gov.in", verified: true, success_count: 2 },
    ]);
    // No user identity in shared rows; run log is server-only.
    expect(await db.system`select 1 from form_mappings where scope in ('WEBSITE', 'GLOBAL') and user_id is not null`).toHaveLength(0);
    await expect(as("alice", "CUSTOMER", (tx) => tx`select 1 from learning_runs`)).rejects.toThrow(/permission denied/);

    // l3 stops contributing → ssc has one supporter left, global two: both demoted (kept, not deleted).
    await as("l3", "CUSTOMER", (tx) => tx`update profiles set learning_contribution_enabled = false where user_id = ${ids.l3!}`);
    const r2 = await runLearning(db.system);
    expect(r2).toMatchObject({ websitePromoted: 0, globalPromoted: 0, demoted: 2 });
    const after = await db.system<{ verified: boolean; verification_source: string }[]>`
      select verified, verification_source from form_mappings where scope in ('WEBSITE', 'GLOBAL') and normalized_label = 'fathers name'`;
    expect(after.every((m) => !m.verified && m.verification_source === "learning_demoted")).toBe(true);

    // Users can forget their own mappings, never someone else's.
    const del = await as("l1", "CUSTOMER", (tx) => tx`delete from form_mappings where scope = 'USER' returning user_id`);
    expect(del.map((d) => d.user_id)).toEqual([ids.l1]);
  });

  it("agent memory: saved answers are private to their owner and erased with the account (0015)", async () => {
    await createUser("ans_a");
    await createUser("ans_b");
    await db.system`insert into profiles (user_id) values (${ids.ans_a!}), (${ids.ans_b!})`;
    const insert = (key: string, owner: string, q: string) =>
      as(key, "CUSTOMER", (tx) => tx`insert into saved_answers (user_id, question, question_norm, answer) values (${owner}, ${q}, ${q.toLowerCase()}, 'enc:x')`);
    await insert("ans_a", ids.ans_a!, "how did you hear about us");
    // Another user can neither see, write nor delete them.
    expect(await as("ans_b", "CUSTOMER", (tx) => tx`select id from saved_answers`)).toHaveLength(0);
    await expect(insert("ans_b", ids.ans_a!, "q")).rejects.toThrow(/row-level security/);
    expect(await as("ans_b", "CUSTOMER", (tx) => tx`delete from saved_answers returning id`)).toHaveLength(0);
    // One answer per question wording.
    await expect(insert("ans_a", ids.ans_a!, "how did you hear about us")).rejects.toThrow(/duplicate key/);
    // Consent to share the professional profile with the AI is off until the user turns it on.
    const [p0] = await as("ans_a", "CUSTOMER", (tx) => tx<{ ai_profile_sharing: boolean }[]>`select ai_profile_sharing from profiles where user_id = ${ids.ans_a!}`);
    expect(p0!.ai_profile_sharing).toBe(false);
    await as("ans_a", "CUSTOMER", (tx) => tx`update profiles set ai_profile_sharing = true where user_id = ${ids.ans_a!}`);
    await eraseUser(db.system, ids.ans_a!);
    const [left] = await db.system<{ n: number }[]>`select count(*)::int as n from saved_answers where user_id = ${ids.ans_a!}`;
    expect(left!.n).toBe(0);
  });
});
