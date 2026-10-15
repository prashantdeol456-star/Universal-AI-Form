import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { controlSchema, createTaskSchema, reportSchema, safeJsonObject } from "./schemas";

/**
 * Source-level guards for the task API (like admin.privacy.test.ts): every handler
 * authenticates first, the owner always comes from the session, ids are validated, and
 * worker payloads cannot smuggle credentials into task rows.
 */
const API = path.resolve(__dirname, "../../app/api");
const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = [...routeFiles(path.join(API, "tasks")), ...routeFiles(path.join(API, "approvals")), ...routeFiles(path.join(API, "sites"))];

describe("task API route guards", () => {
  it("covers all task, approval and site routes", () => {
    expect(files.length).toBe(11);
  });

  for (const file of files) {
    const rel = path.relative(API, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: authenticates before anything else and never trusts a client user id`, () => {
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route[^(]*\(async \([^)]*\)[^{]*\{\n([\s\S]*?)\n\}\);/g)];
      expect(handlers.length, "handlers found").toBeGreaterThan(0);
      for (const [, method, body] of handlers) {
        const first = body!.split("\n").find((l) => l.trim())!.trim();
        expect(first, `${method} must start with requireUser`).toMatch(/^const user = await requireUser\(/);
      }
      expect(src).not.toMatch(/\b(user_?id|userId|ownerId)\b/i);
      // Dynamic ids are validated as UUIDs before use.
      if (rel.includes("[")) expect(src).toMatch(/z\.uuid\(\)\.parse\(/);
    });
  }
});

describe("task API schemas", () => {
  it("refuses credentials and oversized payloads in worker data", () => {
    expect(safeJsonObject.safeParse({ fieldsRead: 3 }).success).toBe(true);
    expect(safeJsonObject.safeParse({ password: "x" }).success).toBe(false);
    expect(safeJsonObject.safeParse({ page: { otp: "123456" } }).success).toBe(false);
    expect(safeJsonObject.safeParse({ list: [{ sessionCookie: "a" }] }).success).toBe(false);
    expect(safeJsonObject.safeParse({ big: "x".repeat(20_001) }).success).toBe(false);
    expect(reportSchema.safeParse({ leaseToken: "not-a-uuid", outcome: "completed" }).success).toBe(false);
    expect(reportSchema.safeParse({ leaseToken: "00000000-0000-4000-8000-000000000000", outcome: "exploded" }).success).toBe(false);
  });

  it("validates task creation and control requests", () => {
    expect(createTaskSchema.safeParse({ taskType: "draft_email", input: { instruction: "hi there" } }).success).toBe(true);
    expect(createTaskSchema.safeParse({ taskType: "Draft Email!" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ taskType: "draft_email", userId: "someone-else" }).data).not.toHaveProperty("userId");
    expect(controlSchema.safeParse({ action: "delete" }).success).toBe(false);
    expect(controlSchema.parse({ action: "retry" })).toEqual({ action: "retry", confirmUncertain: false });
  });
});
