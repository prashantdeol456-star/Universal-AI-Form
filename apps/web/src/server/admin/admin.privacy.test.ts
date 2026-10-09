import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Admin services read across all tenants with the system pool. This guard keeps
 * them away from personal data at the source level: no profile values, filled
 * form values, document text, chat content, and no decryption helpers.
 * Counting rows (e.g. "how many profile fields") is fine; selecting values is not.
 */
const DIR = __dirname;
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bdecrypt\w*\s*\(/, "decryption helper"],
  [/\breadStored\b/, "readStored (decrypts profile values)"],
  [/\bfield_value\b/, "application_fields.field_value"],
  [/\bextracted_text\b|\bfinal_value\b|\braw_value\b/, "document text / extracted values"],
  [/\bchat_messages\b|\bchat_proposals\b/, "chat content"],
  [/\bprevious_value\b|\bnew_value\b|\bold_value\b/, "profile history values"],
  [/select[^`]*\bstorage_key\b[^`]*from\s+documents/is, "document storage keys"],
  [/profile_fields\s+(?!where)\w*\s*(?:join|$)|select\s+[^`]*\bvalue\b[^`]*from\s+profile_fields/is, "reading profile_fields values"],
  [/\bpassword_hash\b(?!\s+is\s+not\s+null)/, "password hashes"],
];

describe("admin services never read personal data", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("has admin service files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(path.join(DIR, file), "utf8");
      const hits = FORBIDDEN.filter(([re]) => re.test(src)).map(([, what]) => what);
      expect(hits, `${file} touches: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("every exported admin function checks permissions first", () => {
    for (const file of files.filter((f) => f !== "guard.ts")) {
      const src = readFileSync(path.join(DIR, file), "utf8");
      const fns = [...src.matchAll(/export async function (\w+)\(actor: Actor[^)]*\)[^{]*\{\s*\n\s*([^\n]+)/g)];
      expect(fns.length, `${file} exports admin functions`).toBeGreaterThan(0);
      for (const [, name, firstLine] of fns) expect(firstLine, `${file}:${name}`).toMatch(/^assertAdmin\(actor, "admin:\w+"\);/);
    }
  });
});
