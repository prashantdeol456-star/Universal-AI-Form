import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const keys = vi.hoisted(() => ({ primaryId: "k2", keys: new Map<string, Buffer>() }));
vi.mock("../db", () => ({
  keyring: () => keys,
  encryptValue: (s: string) => `enc:test:${Buffer.from(s).toString("base64url")}`,
  decryptValue: (s: string) => Buffer.from(s.split(":")[2]!, "base64url").toString("utf8"),
  asUser: vi.fn(),
}));
keys.keys.set("k2", randomBytes(32));
keys.keys.set("k1", randomBytes(32));

const { hashTerm, queryHashes, storeChunks } = await import("./searchIndex");
const { fieldsForQuery } = await import("./retrieval");

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

describe("blind keyword index", () => {
  it("never stores words; the same word hashes differently per user and per key", () => {
    const a = hashTerm("k2", ALICE, "project");
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a).not.toContain("project");
    expect(hashTerm("k2", ALICE, "project")).toBe(a);
    expect(hashTerm("k2", BOB, "project")).not.toBe(a);
    expect(hashTerm("k1", ALICE, "project")).not.toBe(a);
  });

  it("queries match chunks indexed under any key still in the keyring (key rotation)", () => {
    const q = queryHashes(ALICE, "Project managers");
    expect(q).toContain(hashTerm("k2", ALICE, "project"));
    expect(q).toContain(hashTerm("k1", ALICE, "manager"));
    expect(q).not.toContain(hashTerm("k2", BOB, "project"));
    expect(queryHashes(ALICE, "the and of")).toEqual([]);
  });

  it("stores chunks encrypted with hashed terms, replacing earlier chunks", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: strings.join("?"), values });
      return Promise.resolve([]);
    }) as never;
    const r = await storeChunks(tx, { id: "d1", user_id: ALICE }, [
      { page: 1, text: "ASHA VERMA\nasha@example.test" },
      { page: 2, text: "WORK EXPERIENCE\nSenior Project Manager at Acme Logistics." },
    ]);
    expect(r.chunkCount).toBe(statements.length - 1);
    expect(statements[0]!.sql).toMatch(/delete from document_chunks/);
    const inserts = statements.slice(1);
    for (const s of inserts) {
      // No plain text value is passed except numbers, ids, key id and hashes.
      expect(JSON.stringify(s.values)).not.toMatch(/Acme|ASHA|asha@/);
    }
    const work = inserts.find((s) => (s.values[2] as number) >= 0 && s.values[3] === 2)!;
    expect(work.values[9]).toContain(hashTerm("k2", ALICE, "acme"));
  });
});

describe("fields a question is about", () => {
  it("finds profile fields from the question's words", () => {
    expect(fieldsForQuery("What is my highest qualification?")).toContain("education.highest_qualification");
    expect(fieldsForQuery("my date of birth")[0]).toBe("personal.date_of_birth");
    expect(fieldsForQuery("the and of")).toEqual([]);
  });
});
