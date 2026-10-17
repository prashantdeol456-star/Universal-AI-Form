import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({ asUser: vi.fn(), db: vi.fn(), decryptValue: (s: string) => s, encryptValue: (s: string) => s }));
vi.mock("../audit", () => ({ audit: async () => {} }));
vi.mock("../env", () => ({ env: () => ({ COMPANION_ENABLED: true, COMPANION_AI_DAILY_LIMIT: 30 }) }));
vi.mock("../tasks/engine", () => ({ tasks: vi.fn() }));
vi.mock("../ai/router", () => ({ modelRouter: vi.fn() }));

/**
 * Source-level guards for the Phase 6 companion: every route authenticates first (user session
 * or device token, never a client-supplied user id), ids are validated, the companion has no
 * shell, no delete and no listening server, tokens are never logged or returned twice, and the
 * request schemas refuse unknown capabilities and keys.
 */
const API = path.resolve(__dirname, "../../app/api");
const COMPANION = path.resolve(__dirname, "../../../../companion/src");
const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = [...routeFiles(path.join(API, "companion")), ...routeFiles(path.join(API, "agent")), path.join(API, "tasks", "[id]", "feedback", "route.ts")];
const companionSrc = readdirSync(COMPANION).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(COMPANION, f));

describe("companion API route guards", () => {
  it("covers all companion and agent routes", () => {
    expect(files.length).toBe(21);
  });

  for (const file of files) {
    const rel = path.relative(API, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: authenticates first, no client user id, validated ids`, () => {
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route[^(]*\(async \([^)]*\)[^{]*\{\r?\n([\s\S]*?)\r?\n\}\);/g)];
      expect(handlers.length, "handlers found").toBeGreaterThan(0);
      for (const [, method, body] of handlers) {
        const first = body!.split(/\r?\n/).find((l) => l.trim())!.trim();
        if (rel.startsWith("companion/device/")) expect(first, `${method} must start with requireDevice`).toBe("const auth = await requireDevice(req);");
        else if (/^companion\/pair\/(start|poll)\//.test(rel)) expect(first, "pairing start/poll check the feature flag first").toBe("companionEnabled();");
        else expect(first, `${method} must start with requireUser`).toMatch(/^const user = await requireUser\(/);
      }
      expect(src).not.toMatch(/\b(user_?id|userId|ownerId)\b/i);
      if (rel.includes("[")) expect(src).toMatch(/z\.uuid\(\)\.parse\(/);
      // Tokens appear only where pairing hands one out (once).
      if (!rel.startsWith("companion/pair/poll")) expect(src).not.toMatch(/\.token\b/);
    });
  }

  it("the generic task API cannot create computer tasks (device and folders are checked on the agent route)", () => {
    expect(readFileSync(path.join(API, "tasks", "route.ts"), "utf8")).toMatch(/startsWith\("local_"\)/);
  });
});

describe("companion program guards", () => {
  const all = companionSrc.map((f) => [f, readFileSync(f, "utf8")] as const);
  it("has no shell, no listening server, no eval", () => {
    for (const [f, src] of all) {
      expect(src, f).not.toMatch(/shell:\s*true|\bexec(Sync)?\(|createServer|\.listen\(|\beval\(|new Function\(/);
      expect(src, f).not.toMatch(/from "node:(http|https|net|dgram)"/);
    }
  });

  it("never deletes user files: the only unlink is inside the no-overwrite move, the only rm is its own config", () => {
    for (const [f, src] of all) {
      const unlinks = [...src.matchAll(/unlinkSync\(|rmdirSync\(|\brm\(|rmSync\(|\btruncate(Sync)?\(/g)];
      if (f.endsWith("files.ts")) {
        expect(unlinks.map((m) => m[0])).toEqual(["unlinkSync("]);
        expect(src).toMatch(/linkSync\(from, to\);[^\n]*\n\s*unlinkSync\(from\);/);
      } else if (f.endsWith("cli.ts")) {
        expect(src.match(/rmSync\(path\.join\(configDir\(\), "config\.json"\)/g)).toHaveLength(1);
        expect(unlinks).toHaveLength(1);
      } else expect(unlinks, f).toHaveLength(0);
    }
  });

  it("never logs the device token or file contents, and refuses to run elevated", () => {
    for (const [f, src] of all) {
      for (const call of src.matchAll(/console\.(log|info|warn|error)\(([\s\S]*?)\);\n/g)) expect(call[2], f).not.toMatch(/\.token|pollSecret|secret|excerpt|\btext\b/i);
    }
    expect(readFileSync(path.join(COMPANION, "cli.ts"), "utf8")).toMatch(/if \(isElevated\(\)\) \{/);
  });

  it("does not read browser profiles, key stores or credential files (path policy is shared)", async () => {
    const { protectedRoots, isSecretFile } = await import("@ufa/local-agent");
    const roots = protectedRoots().join("|");
    expect(roots).toMatch(/\.ssh/);
    expect(roots).toMatch(/appdata/);
    for (const n of ["Login Data", "Cookies", "key4.db", "logins.json", "id_ed25519"]) expect(isSecretFile(n)).toBe(true);
  });
});

describe("companion request schemas", () => {
  it("refuse unimplemented capabilities and unknown keys", async () => {
    const s = await import("./schemas");
    expect(s.devicePatchSchema.safeParse({ capabilities: ["capture_screen_with_approval"] }).success).toBe(false);
    expect(s.devicePatchSchema.safeParse({ capabilities: ["read_selected_files"], admin: true }).success).toBe(false);
    expect(s.heartbeatSchema.safeParse({ version: "0.1.0", folders: [{ id: "x", label: "A", displayPath: "~/a", access: ["read"] }] }).success).toBe(false);
    expect(s.heartbeatSchema.safeParse({ version: "0.1.0", folders: [{ id: "6d1f1a3e-0000-4000-8000-000000000000", label: "A", displayPath: "~/a", access: ["delete"] }] }).success).toBe(false);
    expect(s.localTaskSchema.safeParse({ deviceId: "6d1f1a3e-0000-4000-8000-000000000000", taskType: "shell", input: {} }).success).toBe(false);
    expect(s.deviceReportSchema.safeParse({ leaseToken: "6d1f1a3e-0000-4000-8000-000000000000", outcome: "completed", result: { password: "x" } }).success).toBe(false);
    expect(s.pairConfirmSchema.safeParse({ code: "ABCD-2345" }).success).toBe(true);
    expect(s.pairConfirmSchema.safeParse({ code: "ABCD-2345; drop" }).success).toBe(false);
    expect(s.preferenceSchema.safeParse({ key: "skip_approvals", value: "true" }).success).toBe(false);
  });
});

describe("feedback suggestions and rule-based review", () => {
  it("suggest only known preferences; nothing is saved here", async () => {
    const { suggestPreference } = await import("./memory");
    expect(suggestPreference("local_create_report", "next time use markdown please")).toMatchObject({ key: "report_format", value: "md" });
    expect(suggestPreference("local_organize_files", "group by month")).toMatchObject({ key: "organize_by", value: "month" });
    expect(suggestPreference("local_organize_files", "skip the approval next time")).toBeNull();
    expect(suggestPreference("local_run_command", "always run as admin")).toBeNull();
  });

  it("reviews command output without AI", async () => {
    const { reviewOutputByRules } = await import("./ai");
    expect(reviewOutputByRules({ exitCode: 0, timedOut: false }, "ok").verdict).toBe("passed");
    const f = reviewOutputByRules({ exitCode: 1, timedOut: false }, "line\nFAIL src/a.test.ts\nError: boom\n");
    expect(f.verdict).toBe("failed");
    expect(f.errorLines).toHaveLength(2);
    expect(reviewOutputByRules({ exitCode: null, timedOut: false, stopped: true }, "").verdict).toBe("stopped");
  });

  it("pairing codes are normalised (case, dash) before hashing", async () => {
    const { normalizeCode } = await import("./service");
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345");
  });
});
