import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chatPatchSchema, connectSchema, draftPatchSchema, importFields, mailSearchSchema } from "./schemas";

/**
 * Source-level guards for the messaging APIs: every handler authenticates first, the owner
 * always comes from the session, ids are validated, nothing can send a message, and tokens
 * never reach a response or a log.
 */
const API = path.resolve(__dirname, "../../app/api");
const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = ["integrations", "mail", "messages", "whatsapp"].flatMap((d) => routeFiles(path.join(API, d)));
const serverFiles = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(__dirname, f));

describe("messaging API route guards", () => {
  it("covers all messaging routes", () => {
    expect(files.length).toBe(14);
  });

  for (const file of files) {
    const rel = path.relative(API, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: authenticates first, no client user id, validated ids`, () => {
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route[^(]*\(async \([^)]*\)[^{]*\{\r?\n([\s\S]*?)\r?\n\}\);/g)];
      expect(handlers.length, "handlers found").toBeGreaterThan(0);
      for (const [, method, body] of handlers) {
        const first = body!.split(/\r?\n/).find((l) => l.trim())!.trim();
        expect(first, `${method} must start with requireUser`).toMatch(/^const user = await requireUser\(/);
      }
      expect(src).not.toMatch(/\b(user_?id|userId|ownerId)\b/i);
      if (rel.includes("[")) expect(src).toMatch(/z\.uuid\(\)\.parse\(|gmailThreadId\.parse\(/);
    });
  }

  it("no messaging code can send email or WhatsApp messages", () => {
    for (const f of [...files, ...serverFiles]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/messages\/send|drafts\/send|graph\.facebook\.com|\/messages"\s*,\s*\{\s*method:\s*"POST"|sendMail\(|nodemailer/);
    }
  });

  it("tokens never go into responses or logs", () => {
    for (const f of [...files, ...serverFiles]) {
      const src = readFileSync(f, "utf8");
      for (const call of src.matchAll(/console\.(log|info|warn|error)\(([\s\S]*?)\);/g)) expect(call[2], f).not.toMatch(/token|refresh|verifier|secret|body|text/i);
      if (f.includes(`${path.sep}app${path.sep}api${path.sep}`)) expect(src, f).not.toMatch(/refresh_token|access_token|\.token\b/);
    }
  });
});

describe("dashboard task requests", () => {
  it("the Messages page builds idempotency keys the task API accepts (regression: ':' was refused)", async () => {
    const { createTaskSchema } = await import("../tasks/schemas");
    const src = readFileSync(path.resolve(__dirname, "../../app/dashboard/messages/useTask.ts"), "utf8");
    const template = /const idempotencyKey = `([^`]+)`/.exec(src)![1]!;
    for (const taskType of ["summarize_email_thread", "draft_email_reply", "summarize_whatsapp_conversation", "draft_whatsapp_reply"]) {
      const key = template.replace("${taskType}", taskType).replace("${crypto.randomUUID()}", "0f8b1f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
      expect(createTaskSchema.safeParse({ taskType, input: {}, idempotencyKey: key }).success, key).toBe(true);
    }
  });
});

describe("messaging request validation", () => {
  it("accepts only the two Gmail access levels", () => {
    expect(connectSchema.safeParse({ access: "read" }).success).toBe(true);
    expect(connectSchema.safeParse({ access: "send" }).success).toBe(false);
    expect(connectSchema.safeParse({ access: "read", scopes: ["https://mail.google.com/"] }).success).toBe(false);
  });

  it("bounds searches and draft edits; recipients cannot be edited", () => {
    expect(mailSearchSchema.safeParse({ from: "x".repeat(101) }).success).toBe(false);
    expect(mailSearchSchema.safeParse({ after: "yesterday" }).success).toBe(false);
    expect(mailSearchSchema.safeParse({ pageToken: "abc def" }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ body: "new text" }).success).toBe(true);
    expect(draftPatchSchema.safeParse({ to: ["evil@example.net"] }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ status: "sent" }).success).toBe(false);
    expect(chatPatchSchema.safeParse({ retentionDays: 1000 }).success).toBe(false);
    expect(importFields.safeParse({ myName: "" }).success).toBe(false);
  });
});
