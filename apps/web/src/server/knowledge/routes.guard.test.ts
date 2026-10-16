import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for the document library and knowledge base APIs (like
 * api.guard.test.ts): every handler authenticates first, the owner comes from the session,
 * ids are validated as UUIDs (so a guessed or malformed id is refused before any query),
 * and search/answer endpoints are rate limited and never cached.
 */
const API = path.resolve(__dirname, "../../app/api");
const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = [...routeFiles(path.join(API, "documents")), ...routeFiles(path.join(API, "knowledge"))];

describe("document and knowledge API route guards", () => {
  it("covers the document and knowledge routes", () => {
    expect(files.length).toBe(7);
  });

  for (const file of files) {
    const rel = path.relative(API, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: authenticates first, never trusts a client user id`, () => {
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route[^(]*\(async \([^)]*\)[^{]*\{\r?\n([\s\S]*?)\r?\n\}\);/g)];
      expect(handlers.length, "handlers found").toBeGreaterThan(0);
      for (const [, method, body] of handlers) {
        const first = body!.split(/\r?\n/).find((l) => l.trim())!.trim();
        expect(first, `${method} must start with requireUser`).toMatch(/^const user = await requireUser\(/);
      }
      expect(src).not.toMatch(/\b(user_?id|userId|ownerId)\b/i);
      if (rel.includes("[")) expect(src).toMatch(/z\.uuid\(\)\.parse\(/);
    });
  }

  it("search and answer are rate limited and not cached", () => {
    const knowledge = files.filter((x) => x.includes(`${path.sep}knowledge${path.sep}`));
    expect(knowledge).toHaveLength(2);
    for (const f of knowledge) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/rateLimit\("knowledge-/);
      expect(src).toMatch(/"Cache-Control": "no-store"/);
    }
  });

  it("knowledge services never log document text or questions", () => {
    for (const f of readdirSync(__dirname).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(__dirname, f), "utf8");
      for (const call of src.matchAll(/console\.(log|info|warn|error)\(([\s\S]*?)\);/g)) {
        expect(call[2], `${f} logs`).not.toMatch(/\b(text|excerpts?|content|raw|query|question)\b/);
      }
    }
  });
});
