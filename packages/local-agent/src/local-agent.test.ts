import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLocalStep, IMPLEMENTED_CAPABILITIES, type FolderGrant } from "./capabilities";
import { capOutput, commandEnv, commandTemplate, COMMAND_TEMPLATES } from "./commands";
import { classifyFile, planHash, planOrganize } from "./organize";
import { isSecretFile, PathPolicyError, resolveInside, safeFileName, validateGrantRoot } from "./paths";
import { LOCAL_TASK_INPUTS, missingFor, planLocalTask, validateModelPlan, type PlanContext } from "./plan";

// The OS temp dir lives under AppData (a protected root), so tests use the repo's ignored .data folder.
const base = path.resolve(__dirname, "../../../.data", `test-local-agent-${process.pid}`);
const granted = path.join(base, "granted");
const outside = path.join(base, "outside");

beforeAll(() => {
  mkdirSync(path.join(granted, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(granted, "a.txt"), "hello");
  writeFileSync(path.join(granted, ".env"), "SECRET=1");
  writeFileSync(path.join(granted, "id_rsa"), "key");
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  mkdirSync(path.join(granted, ".git"), { recursive: true });
  writeFileSync(path.join(granted, ".git", "config"), "x");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("path policy", () => {
  it("accepts a normal folder and resolves files inside it", () => {
    const root = validateGrantRoot(granted);
    expect(resolveInside(root, "a.txt")).toMatch(/a\.txt$/);
    expect(resolveInside(root, "sub/new.csv", false)).toMatch(/new\.csv$/);
  });

  it("rejects traversal, absolute paths and null bytes", () => {
    for (const bad of ["../outside/secret.txt", "sub/../../outside/secret.txt", path.join(outside, "secret.txt"), "C:\\Windows\\win.ini", "/etc/passwd", "a\0.txt"]) {
      expect(() => resolveInside(granted, bad)).toThrow(PathPolicyError);
    }
  });

  it("rejects secret files and repository internals inside a granted folder", () => {
    expect(() => resolveInside(granted, ".env")).toThrow(PathPolicyError);
    expect(() => resolveInside(granted, "id_rsa")).toThrow(PathPolicyError);
    expect(() => resolveInside(granted, ".git/config")).toThrow(PathPolicyError);
    expect(() => resolveInside(granted, "new.pem", false)).toThrow(PathPolicyError);
  });

  it("rejects a link that points outside the granted folder", () => {
    const link = path.join(granted, "escape");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // links not permitted on this machine; covered by the realpath check below
    }
    expect(() => resolveInside(granted, "escape/secret.txt")).toThrow(/outside/);
    expect(() => resolveInside(granted, "escape/new.txt", false)).toThrow(/outside/);
  });

  it("refuses home, drive roots, system and credential folders", () => {
    expect(() => validateGrantRoot(os.homedir())).toThrow(PathPolicyError);
    expect(() => validateGrantRoot(path.parse(granted).root)).toThrow(PathPolicyError);
    expect(() => validateGrantRoot(os.tmpdir())).toThrow(PathPolicyError); // under AppData on Windows
    if (process.platform === "win32") expect(() => validateGrantRoot(process.env.SystemRoot ?? "C:\\Windows")).toThrow(PathPolicyError);
    else expect(() => validateGrantRoot("/etc")).toThrow(PathPolicyError);
    expect(() => validateGrantRoot(path.join(base, "missing"))).toThrow(/does not exist/);
  });

  it("recognises secret file names and unsafe new file names", () => {
    for (const n of ["id_ed25519", ".env.local", "Login Data", "Cookies", "key4.db", "logins.json", "vault.kdbx", "server.key"]) expect(isSecretFile(n)).toBe(true);
    expect(isSecretFile("invoice.pdf")).toBe(false);
    for (const n of ["a/b.csv", "..", "con.txt", "x:y", "", ".env"]) expect(() => safeFileName(n)).toThrow(PathPolicyError);
    expect(safeFileName(" report.csv ")).toBe("report.csv");
  });
});

describe("capability policy", () => {
  const folder: FolderGrant = { id: "f", label: "Invoices", path: granted, access: ["read"] };
  it("default is no access, and every gate is checked", () => {
    expect(checkLocalStep({ stepType: "local.list_files", capabilities: [], folder, stopped: false }).allowed).toBe(false);
    expect(checkLocalStep({ stepType: "local.list_files", capabilities: ["list_approved_folders"], folder, stopped: false }).allowed).toBe(true);
    expect(checkLocalStep({ stepType: "local.list_files", capabilities: ["list_approved_folders"], folder, stopped: true })).toMatchObject({ allowed: false, reason: /stop/i });
    expect(checkLocalStep({ stepType: "local.apply_changes", capabilities: ["move_selected_files"], folder, stopped: false })).toMatchObject({ allowed: false, reason: /not approved for write/ });
    expect(checkLocalStep({ stepType: "local.list_files", capabilities: ["list_approved_folders"], folder: null, stopped: false }).allowed).toBe(false);
    expect(checkLocalStep({ stepType: "local.shell", capabilities: IMPLEMENTED_CAPABILITIES, folder, stopped: false }).allowed).toBe(false);
  });
  it("screen and input capabilities are not implemented", () => {
    expect(IMPLEMENTED_CAPABILITIES).not.toContain("capture_screen_with_approval");
    expect(IMPLEMENTED_CAPABILITIES).not.toContain("interact_with_approved_application");
    expect(IMPLEMENTED_CAPABILITIES).not.toContain("read_active_window");
  });
});

describe("command templates", () => {
  it("are fixed programs with fixed arguments (no shell, no interpolation)", () => {
    for (const c of COMMAND_TEMPLATES) {
      expect(["npm", "npx", "node", "git", "python"]).toContain(c.program);
      for (const a of c.args) expect(a).not.toMatch(/[;&|`$<>]|\$\{/);
    }
    expect(commandTemplate("rm_rf")).toBeNull();
  });
  it("environment drops secrets and output is capped", () => {
    const env = commandEnv({ PATH: "/bin", GEMINI_API_KEY: "x", DATABASE_URL: "y", COMPANION_TOKEN: "z" });
    expect(env).toMatchObject({ PATH: "/bin", CI: "1" });
    expect(Object.keys(env)).not.toContain("GEMINI_API_KEY");
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
    const big = capOutput("a".repeat(100) + "END", 40);
    expect(big.truncated).toBe(true);
    expect(big.text.endsWith("END")).toBe(true);
  });
});

describe("organise plans", () => {
  const files = [
    { name: "b.pdf", size: 1, modifiedAt: "2026-01-05T00:00:00Z" },
    { name: "a.jpg", size: 1, modifiedAt: "2026-02-05T00:00:00Z" },
    { name: "setup.exe", size: 1, modifiedAt: "2026-02-05T00:00:00Z" },
  ];
  it("classifies deterministically and never overwrites", () => {
    expect(classifyFile("x.PDF")).toBe("Documents");
    expect(classifyFile("run.ps1")).toMatch(/not opened/);
    const { moves } = planOrganize(files, "type", new Set(["Documents/b.pdf"]));
    expect(moves.find((m) => m.from === "b.pdf")!.to).toBe("Documents/b (2).pdf");
    expect(new Set(moves.map((m) => m.to.toLowerCase())).size).toBe(moves.length);
    expect(planOrganize(files, "month").moves.map((m) => m.to)).toContain("2026-01/b.pdf");
  });
  it("hash changes when any move changes", () => {
    const a = planOrganize(files, "type").moves;
    const b = planOrganize(files, "extension").moves;
    expect(planHash(a)).toBe(planHash(planOrganize(files, "type").moves));
    expect(planHash(a)).not.toBe(planHash(b));
  });
});

describe("task planning", () => {
  const dev = "11111111-1111-4111-8111-111111111111";
  const inv = "22222222-2222-4222-8222-222222222222";
  const out = "33333333-3333-4333-8333-333333333333";
  const proj = "44444444-4444-4444-8444-444444444444";
  const ctx: PlanContext = {
    deviceId: dev,
    capabilities: ["list_approved_folders", "read_selected_files"],
    folders: [
      { id: inv, label: "Invoices", access: ["read"] },
      { id: out, label: "Reports", access: ["read", "write"] },
      { id: proj, label: "my-app", access: ["read", "run"] },
    ],
    preferences: {},
  };

  it("plans a summary and reports nothing missing when allowed", () => {
    const r = planLocalTask("Summarise the PDF invoices in Invoices", ctx);
    expect(r.ok && r.plan.taskType).toBe("local_summarize_files");
    if (r.ok) {
      expect(r.plan.input).toMatchObject({ folderId: inv, extensions: ["pdf"], nameContains: "invoice" });
      expect(r.plan.missing).toEqual([]);
    }
  });

  it("identifies missing capabilities and folder access", () => {
    const r = planLocalTask("run the tests in my-app", ctx);
    expect(r.ok && r.plan.taskType).toBe("local_run_command");
    if (r.ok) expect(r.plan.missing.join(" ")).toMatch(/allowlisted commands/);
    const o = planLocalTask("organise Reports by month", ctx);
    if (!o.ok) throw new Error(o.question);
    expect(o.plan.input).toMatchObject({ folderId: out, by: "month" });
    expect(o.plan.missing.join(" ")).toMatch(/Rename \/ move/);
  });

  it("uses the summary-length preference unless the request says otherwise", () => {
    const short = planLocalTask("summarise the files in Invoices", { ...ctx, preferences: { summaryLength: "detailed" } });
    expect(short.ok && short.plan.input.detail).toBe("detailed");
    const asked = planLocalTask("give a detailed summary of the files in Invoices", ctx);
    expect(asked.ok && asked.plan.input.detail).toBe("detailed");
    expect(planLocalTask("summarise the files in Invoices", ctx)).toMatchObject({ ok: true, plan: { input: { detail: "short" } } });
  });

  it("asks instead of guessing", () => {
    expect(planLocalTask("summarise the files", ctx)).toMatchObject({ ok: false, question: /Which folder/ });
    expect(planLocalTask("book me a flight", ctx).ok).toBe(false);
    expect(planLocalTask("undo that", ctx)).toMatchObject({ ok: false });
  });

  it("model plans cannot point at unknown folders, other devices or unknown task types", () => {
    expect(validateModelPlan({ task_type: "local_summarize_files", input: { folderId: "55555555-5555-4555-8555-555555555555" }, explanation: "x" }, ctx).ok).toBe(false);
    expect(validateModelPlan({ task_type: "shell", input: {}, explanation: "x" }, ctx).ok).toBe(false);
    const r = validateModelPlan({ task_type: "local_summarize_files", input: { folderId: inv, deviceId: "66666666-6666-4666-8666-666666666666" }, explanation: "x" }, ctx);
    expect(r.ok && r.plan.input.deviceId).toBe(dev);
    expect(LOCAL_TASK_INPUTS.local_run_command.safeParse({ deviceId: dev, folderId: proj, commandId: "rm -rf /" }).success).toBe(false);
    expect(missingFor({ taskType: "local_create_report", input: { sourceFolderId: inv, outputFolderId: inv } }, ctx).join(" ")).toMatch(/for write/);
  });
});
