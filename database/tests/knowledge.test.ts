/**
 * Knowledge base (migration 0018) against a real PostgreSQL: chunk RLS and ownership,
 * encrypted-content constraint, blind-index matching per user, per-document cloud AI
 * consent, and deletion of derived content. Synthetic data only.
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

run("knowledge base (0018)", () => {
  let db: Db;
  const ids: Record<string, string> = {};
  const docs: Record<string, string> = {};
  const as = <T>(key: string, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, { userId: ids[key]!, role: "CUSTOMER" }, fn);

  async function createUser(key: string) {
    const [u] = await db.system<{ id: string }[]>`insert into users (email, full_name, password_hash, role) values (${`${key}@kb.test`}, ${key}, 'x', 'CUSTOMER') returning id`;
    ids[key] = u!.id;
  }
  async function createDoc(user: string, name: string) {
    const [d] = await db.system<{ id: string }[]>`
      insert into documents (user_id, document_type, storage_key, original_filename, mime_type, size_bytes, sha256, status, extracted_text)
      values (${ids[user]!}, 'resume', ${`users/x/${name}`}, ${name}, 'application/pdf', 10, ${`sha-${name}-${Math.random()}`}, 'EXTRACTED', 'enc:k1:a:b:c')
      returning id`;
    docs[name] = d!.id;
    return d!.id;
  }
  async function addChunk(user: string, doc: string, index: number, terms: string[]) {
    await db.system`
      insert into document_chunks (user_id, document_id, chunk_index, page_number, content_encrypted, char_count, token_count, index_key_id, terms)
      values (${ids[user]!}, ${doc}, ${index}, 1, 'enc:k1:iv:tag:ct', 100, 20, 'k1', ${terms}::text[])`;
  }

  beforeAll(async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await ensureAppRole(owner, APP_PASSWORD);
    await migrate(owner, MIGRATIONS);
    await owner.end();
    db = createDb({ systemUrl: OWNER_URL!, appUrl: APP_URL!, maxConnections: 4 });
    for (const k of ["k_alice", "k_bob"]) await createUser(k);
    await createDoc("k_alice", "alice-cv.pdf");
    await createDoc("k_bob", "bob-cv.pdf");
    await addChunk("k_alice", docs["alice-cv.pdf"]!, 0, ["hA_project", "hA_manager"]);
    await addChunk("k_alice", docs["alice-cv.pdf"]!, 1, ["hA_education"]);
    await addChunk("k_bob", docs["bob-cv.pdf"]!, 0, ["hB_project", "hA_project"]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("users see only their own chunks, even when a hash matches", async () => {
    const mine = await as("k_alice", (tx) => tx<{ chunk_index: number }[]>`select chunk_index from document_chunks where terms && ${["hA_project"]}::text[] order by chunk_index`);
    expect(mine.map((r) => r.chunk_index)).toEqual([0]);
    // Bob's chunk carries the same hash string but RLS hides Alice's rows from him and his from her.
    const bob = await as("k_bob", (tx) => tx<{ user_id: string }[]>`select user_id from document_chunks`);
    expect(bob.every((r) => r.user_id === ids.k_bob)).toBe(true);
    expect(await as("k_bob", (tx) => tx`select id from document_chunks where document_id = ${docs["alice-cv.pdf"]!}`)).toHaveLength(0);
  });

  it("the runtime role cannot write chunks (worker only)", async () => {
    await expect(
      as("k_alice", (tx) => tx`insert into document_chunks (user_id, document_id, chunk_index, content_encrypted, char_count, token_count, index_key_id, terms)
        values (${ids.k_alice!}, ${docs["alice-cv.pdf"]!}, 9, 'enc:x', 1, 1, 'k1', ${["t"]}::text[])`),
    ).rejects.toThrow(/permission denied/);
    await expect(as("k_alice", (tx) => tx`update document_chunks set terms = ${["x"]}::text[]`)).rejects.toThrow(/permission denied/);
    await expect(as("k_alice", (tx) => tx`delete from document_chunks`)).rejects.toThrow(/permission denied/);
  });

  it("chunks must belong to the document's owner and be encrypted", async () => {
    await expect(addChunk("k_bob", docs["alice-cv.pdf"]!, 5, ["x"])).rejects.toThrow(/chunk owner must match/);
    await expect(
      db.system`insert into document_chunks (user_id, document_id, chunk_index, content_encrypted, char_count, token_count, index_key_id, terms)
        values (${ids.k_alice!}, ${docs["alice-cv.pdf"]!}, 7, 'plain text CV', 13, 3, 'k1', ${["x"]}::text[])`,
    ).rejects.toThrow(/check constraint/);
    await expect(addChunk("k_alice", docs["alice-cv.pdf"]!, 0, ["dup"])).rejects.toThrow(/duplicate key/);
  });

  it("cloud AI consent is per document, off by default, and only the owner can change it", async () => {
    const [d] = await db.system<{ cloud_ai_allowed: boolean }[]>`select cloud_ai_allowed from documents where id = ${docs["alice-cv.pdf"]!}`;
    expect(d!.cloud_ai_allowed).toBe(false);
    expect(await as("k_bob", (tx) => tx`update documents set cloud_ai_allowed = true where id = ${docs["alice-cv.pdf"]!} returning id`)).toHaveLength(0);
    expect(await as("k_alice", (tx) => tx`update documents set cloud_ai_allowed = true where id = ${docs["alice-cv.pdf"]!} returning id`)).toHaveLength(1);
    // Processing columns stay worker-only.
    await expect(as("k_alice", (tx) => tx`update documents set chunk_count = 99 where id = ${docs["alice-cv.pdf"]!}`)).rejects.toThrow(/permission denied/);
  });

  it("deleting a document removes its chunks, text and unconfirmed extractions; confirmed values stay", async () => {
    const doc = await createDoc("k_alice", "old-cv.pdf");
    await addChunk("k_alice", doc, 0, ["hA_old"]);
    await db.system`update documents set chunk_count = 1 where id = ${doc}`;
    await db.system`
      insert into document_extractions (document_id, user_id, field_key, extracted_value, status)
      values (${doc}, ${ids.k_alice!}, 'personal.full_name', 'Asha', 'PENDING'),
             (${doc}, ${ids.k_alice!}, 'contact.email', 'a@example.test', 'CONFIRMED'),
             (${doc}, ${ids.k_alice!}, 'employment.company', 'Acme', 'REJECTED')`;
    // The owner soft-deletes through the runtime role (the only column it may set).
    expect(await as("k_alice", (tx) => tx`update documents set deleted_at = now() where id = ${doc} returning id`)).toHaveLength(1);
    const [after] = await db.system<{ extracted_text: string | null; chunk_count: number }[]>`select extracted_text, chunk_count from documents where id = ${doc}`;
    expect(after).toEqual({ extracted_text: null, chunk_count: 0 });
    expect(await db.system`select id from document_chunks where document_id = ${doc}`).toHaveLength(0);
    const left = await db.system<{ status: string }[]>`select status from document_extractions where document_id = ${doc}`;
    expect(left.map((r) => r.status)).toEqual(["CONFIRMED"]);
    // Other documents are untouched.
    expect(await db.system`select id from document_chunks where document_id = ${docs["alice-cv.pdf"]!}`).toHaveLength(2);
  });

  it("deleting the user removes everything (cascade)", async () => {
    await createUser("k_carol");
    const doc = await createDoc("k_carol", "carol.pdf");
    await addChunk("k_carol", doc, 0, ["hC"]);
    await db.system`delete from users where id = ${ids.k_carol!}`;
    expect(await db.system`select id from document_chunks where document_id = ${doc}`).toHaveLength(0);
  });
});
