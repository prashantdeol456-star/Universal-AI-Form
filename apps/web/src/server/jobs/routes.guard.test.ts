import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addJobSchema, applicationSchema, preferencesSchema, saveSchema, searchSchema } from "./schemas";

/**
 * Source-level guards for the jobs API (like the task and knowledge guards) plus request
 * validation: every handler authenticates first, the owner comes from the session, ids
 * are UUIDs, and no route can submit an application or upload a document.
 */
const API = path.resolve(__dirname, "../../app/api/jobs");
const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = routeFiles(API);

describe("jobs API route guards", () => {
  it("covers all jobs routes", () => {
    expect(files.length).toBe(17);
  });

  for (const file of files) {
    const rel = path.relative(API, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: authenticates first, no client user id, UUID ids`, () => {
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

  it("no jobs code submits applications, uploads documents or calls provider POST endpoints", () => {
    const dirs = [API, __dirname, path.resolve(__dirname, "../../../../../packages/jobs/src")];
    for (const dir of dirs) {
      for (const f of routeFiles(dir).concat(readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts")).map((x) => path.join(dir, x)))) {
        const src = readFileSync(f, "utf8");
        expect(src, f).not.toMatch(/method:\s*["']POST["']/);
        expect(src, f).not.toMatch(/readDocumentForAttach|attachFileInTab|fetchDocumentForAttach/);
        expect(src, f).not.toMatch(/linkedin\.com\/(voyager|jobs\/api)|naukri\.com\/(jobapi|cloudgateway)/i);
      }
    }
  });
});

describe("jobs request validation", () => {
  it("bounds and validates search filters", () => {
    expect(searchSchema.parse({ minScore: "50", page: "2", includeClosed: "true" })).toMatchObject({ minScore: 50, page: 2, includeClosed: true });
    expect(searchSchema.safeParse({ pageSize: "500" }).success).toBe(false);
    expect(searchSchema.safeParse({ minScore: "101" }).success).toBe(false);
    expect(searchSchema.safeParse({ since: "2026-13-40" }).success).toBe(false);
    expect(searchSchema.safeParse({ arrangement: "moon" }).success).toBe(false);
    expect(searchSchema.safeParse({ q: "x".repeat(200) }).success).toBe(false);
  });

  it("refuses unknown keys and unknown statuses", () => {
    expect(addJobSchema.safeParse({ url: "https://x.example.com/j", userId: "someone" }).success).toBe(false);
    expect(applicationSchema.safeParse({ status: "submitted_by_ai" }).success).toBe(false);
    expect(applicationSchema.safeParse({ status: "applied", confirmSubmitted: true }).success).toBe(true);
    expect(applicationSchema.safeParse({ applicationUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(saveSchema.safeParse({ saved: true, priority: 9 }).success).toBe(false);
  });

  it("preferences are optional and consistent", () => {
    const empty = { roles: [], locations: [], workArrangements: [], employmentTypes: [], industries: [], experienceMin: null, experienceMax: null, salaryMin: null, salaryMax: null, salaryCurrency: null };
    expect(preferencesSchema.safeParse(empty).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...empty, experienceMin: 8, experienceMax: 2 }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...empty, workArrangements: ["remote", "space"] }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...empty, salaryCurrency: "rupees" }).success).toBe(false);
  });
});
