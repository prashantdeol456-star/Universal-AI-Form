import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planHash, validateGrantRoot } from "@ufa/local-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeStep, type AgentState } from "./agent";
import type { Claim } from "./api";
import { isElevated, runCommand } from "./commands";
import type { CompanionConfig } from "./config";
import { applyChanges, extractiveSummary, listFiles, planOrganizeStep, summarizeFiles, undoChanges, writeReport } from "./files";

// Real files in the repository's ignored .data folder (the OS temp folder is under a protected root).
const base = path.resolve(__dirname, "../../../.data", `test-companion-${process.pid}`);
const home = path.join(base, "home");
const work = path.join(base, "work");
const outside = path.join(base, "outside");
const never = new AbortController().signal;
const noop = () => {};

beforeAll(() => {
  process.env.UFA_COMPANION_HOME = home;
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "private.txt"), "outside");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
});

const put = (rel: string, content = "x") => {
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), content);
};

describe("listing", () => {
  it("skips secrets, hidden files, repository internals and links leaving the folder", () => {
    put("a.pdf");
    put(".env", "SECRET=1");
    put("id_rsa", "key");
    put(".git/config");
    put("node_modules/x/index.js");
    put("sub/b.txt");
    try {
      symlinkSync(outside, path.join(work, "escape"), "junction");
    } catch {
      // links not permitted here
    }
    const names = listFiles(work, {}).files.map((f) => f.path);
    expect(names).toEqual(["a.pdf", "sub/b.txt"]);
  });
});

describe("summaries", () => {
  it("summarises text on the computer, masks ID numbers, and sends excerpts only when allowed", async () => {
    put("notes.txt", "Invoice for March\nTotal due 4500\nAadhaar 2345 6789 0123\n");
    put("photo.jpg", "binary");
    const without = await summarizeFiles(work, { maxFiles: 10 }, { excerpts: false, signal: never });
    const data = JSON.parse(without.secret!) as { files: Array<{ summary: string; excerpt: string | null }> };
    expect(without.result).toMatchObject({ files: 1, read: 1 });
    expect(data.files[0]!.summary).toContain("Invoice for March");
    expect(data.files[0]!.summary).not.toContain("2345 6789 0123");
    expect(data.files[0]!.excerpt).toBeNull();
    const withEx = JSON.parse((await summarizeFiles(work, {}, { excerpts: true, signal: never })).secret!) as { files: Array<{ excerpt: string | null }> };
    expect(withEx.files[0]!.excerpt).toContain("Total due");
    expect(withEx.files[0]!.excerpt).not.toContain("2345 6789 0123");
    expect(extractiveSummary("").summary).toBe("(no text)");
  });
});

describe("organise, apply and undo", () => {
  it("applies exactly the approved plan, never overwrites, verifies, and undoes", () => {
    put("b.pdf", "pdf");
    put("a.jpg", "jpg");
    put("Documents/b.pdf", "existing");
    const taskId = randomUUID();
    const plan = planOrganizeStep(work, taskId, "f1", "type");
    const moves = (JSON.parse(plan.secret!) as { moves: Array<{ from: string; to: string }> }).moves;
    expect(moves).toEqual([
      { from: "a.jpg", to: "Images/a.jpg" },
      { from: "b.pdf", to: "Documents/b (2).pdf" },
    ]);
    expect(existsSync(path.join(work, "a.jpg"))).toBe(true); // planning moves nothing

    expect(applyChanges(work, taskId, "0".repeat(64), never, noop)).toMatchObject({ outcome: "failed", message: /does not match/ });
    expect(existsSync(path.join(work, "a.jpg"))).toBe(true);

    const done = applyChanges(work, taskId, String(plan.result!.planSha), never, noop);
    expect(done).toMatchObject({ outcome: "completed", result: { moved: 2, verified: true } });
    expect(readFileSync(path.join(work, "Documents", "b.pdf"), "utf8")).toBe("existing");
    expect(readFileSync(path.join(work, "Documents", "b (2).pdf"), "utf8")).toBe("pdf");

    const undoId = undoChanges(work, taskId, "f1", never);
    expect(undoId).toMatchObject({ outcome: "completed", result: { restored: 2, skipped: 0 } });
    expect(readFileSync(path.join(work, "b.pdf"), "utf8")).toBe("pdf");
    expect(readFileSync(path.join(work, "Documents", "b.pdf"), "utf8")).toBe("existing");
    expect(undoChanges(work, taskId, "f1", never).message).toMatch(/Already undone/);
  });

  it("skips a move whose target appeared after planning, and undo leaves changed files alone", () => {
    put("a.jpg", "jpg");
    put("c.png", "png");
    const taskId = randomUUID();
    const plan = planOrganizeStep(work, taskId, "f1", "type");
    put("Images/a.jpg", "someone else's");
    const r = applyChanges(work, taskId, String(plan.result!.planSha), never, noop);
    expect(r.result).toMatchObject({ moved: 1, skipped: 1 });
    expect(readFileSync(path.join(work, "Images", "a.jpg"), "utf8")).toBe("someone else's");
    expect(existsSync(path.join(work, "a.jpg"))).toBe(true);
    // The moved file was edited afterwards: undo does not touch it.
    writeFileSync(path.join(work, "Images", "c.png"), "edited later, longer");
    utimesSync(path.join(work, "Images", "c.png"), new Date(), new Date(Date.now() + 60_000));
    expect(undoChanges(work, taskId, "f1", never).result).toMatchObject({ restored: 0, skipped: 1 });
    expect(undoChanges(work, randomUUID(), "f1", never).outcome).toBe("failed");
  });

  it("stops between moves when the emergency stop aborts", () => {
    for (let i = 0; i < 5; i++) put(`f${i}.txt`);
    const taskId = randomUUID();
    const plan = planOrganizeStep(work, taskId, "f1", "type");
    const ctl = new AbortController();
    ctl.abort();
    const r = applyChanges(work, taskId, String(plan.result!.planSha), ctl.signal, noop);
    expect(r).toMatchObject({ outcome: "failed", result: { moved: 0, stopped: true } });
    expect(readdirSync(work).filter((f) => f.endsWith(".txt"))).toHaveLength(5);
  });
});

describe("reports", () => {
  it("creates a new file once, never overwrites, and neutralises spreadsheet formulas", () => {
    put("=HYPERLINK(evil).pdf");
    put("invoice-1.pdf");
    mkdirSync(path.join(work, "out"));
    const ok = writeReport(work, path.join(work, "out"), { fileName: "r.csv", format: "csv" }, "r.csv");
    expect(ok).toMatchObject({ outcome: "completed", result: { rows: 2, verified: true } });
    const csv = readFileSync(path.join(work, "out", "r.csv"), "utf8");
    expect(csv).toContain("'=HYPERLINK(evil).pdf");
    expect(writeReport(work, path.join(work, "out"), { fileName: "r.csv", format: "csv" }, "r.csv")).toMatchObject({ outcome: "failed", message: /already exists/ });
    expect(writeReport(work, path.join(work, "out"), { fileName: "other.csv", format: "csv" }, "r.csv")).toMatchObject({ outcome: "failed", message: /does not match/ });
    expect(() => writeReport(work, path.join(work, "out"), { fileName: "../escape.csv", format: "csv" }, "../escape.csv")).toThrow();
  });
});

describe("commands", () => {
  it("runs a fixed template without a shell and without the companion's environment secrets", async () => {
    put("package.json", JSON.stringify({ name: "t", private: true, scripts: { test: "node -e \"console.log('SECRET=' + (process.env.UFA_TEST_SECRET || 'none'))\"" } }));
    process.env.UFA_TEST_SECRET = "should-not-leak";
    const r = await runCommand(work, "npm_test", never, noop);
    delete process.env.UFA_TEST_SECRET;
    expect(r.outcome).toBe("completed");
    expect(r.result).toMatchObject({ exitCode: 0, timedOut: false, stopped: false });
    expect(r.secret).toContain("SECRET=none");
  }, 60_000);

  it("the emergency stop kills a running command", async () => {
    put("package.json", JSON.stringify({ name: "t", private: true, scripts: { test: "node -e \"setTimeout(() => {}, 60000)\"" } }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 2500);
    const started = Date.now();
    const r = await runCommand(work, "npm_test", ctl.signal, noop);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r).toMatchObject({ outcome: "failed", message: /emergency stop/, result: { stopped: true } });
  }, 60_000);

  it("refuses unknown templates and folders without the required file", async () => {
    expect((await runCommand(work, "rm_rf", never, noop)).outcome).toBe("failed");
    expect(await runCommand(work, "npm_lint", never, noop)).toMatchObject({ outcome: "failed", message: /no package.json/ });
  });

  it("is not running elevated in this test", () => {
    expect(isElevated()).toBe(false);
  });
});

describe("local policy before every step", () => {
  const cfg = (): CompanionConfig => ({ server: "http://localhost", deviceId: randomUUID(), token: "t", name: "PC", folders: [{ id: "f1", label: "Work", path: validateGrantRoot(work), access: ["read"] }] });
  const state: AgentState = { stopped: false, capabilities: [], aiExcerptsAllowed: false, current: null };
  const claim = (type: string, caps: string[], input: Record<string, unknown> = {}, previous: Claim["previous"] = {}): Claim => ({
    leaseToken: randomUUID(),
    task: { id: randomUUID(), type: "local_x", input: { folderId: "f1", ...input } },
    step: { id: randomUUID(), key: "k", type, input: {} },
    previous,
    capabilities: caps,
    aiExcerptsAllowed: false,
  });

  it("refuses without the capability, without folder access, unknown actions, and while stopped", async () => {
    put("a.txt");
    expect(await executeStep(cfg(), state, claim("local.list_files", []), never, noop)).toMatchObject({ outcome: "failed", message: /Not allowed/ });
    expect((await executeStep(cfg(), state, claim("local.list_files", ["list_approved_folders"]), never, noop)).outcome).toBe("completed");
    expect(await executeStep(cfg(), state, claim("local.apply_changes", ["move_selected_files"]), never, noop)).toMatchObject({ outcome: "failed", message: /not approved for write/ });
    expect(await executeStep(cfg(), state, claim("local.shell", ["run_approved_command"]), never, noop)).toMatchObject({ outcome: "failed" });
    expect(await executeStep(cfg(), state, claim("local.list_files", ["list_approved_folders"], { folderId: "other" }), never, noop)).toMatchObject({ outcome: "failed", message: /not approved on this computer/ });
    expect(await executeStep(cfg(), { ...state, stopped: true }, claim("local.list_files", ["list_approved_folders"]), never, noop)).toMatchObject({ outcome: "failed", message: /stop/i });
  });

  it("a command runs only if it is the one approved", async () => {
    const c = cfg();
    c.folders[0]!.access = ["read", "run"];
    const r = await executeStep(c, state, claim("local.run_command", ["run_approved_command"], { commandId: "npm_test" }, { approve: { approved: true, commandId: "npm_build" } }), never, noop);
    expect(r).toMatchObject({ outcome: "failed", message: /does not match/ });
  });

  it("planHash binds the approved moves", () => {
    expect(planHash([{ from: "a", to: "b/a" }])).not.toBe(planHash([{ from: "a", to: "c/a" }]));
    expect(statSync(work).isDirectory()).toBe(true);
    expect(spawnSync(process.execPath, ["-e", "1"]).status).toBe(0);
  });
});

describe("automatic start", () => {
  it("Windows: a visible, minimised window, never hidden or elevated; Linux: a systemd user service without root", async () => {
    const { startupContent } = await import("./autostart");
    const win = startupContent("windows", "C:/node/node.exe", "C:/repo/companion.mjs", null);
    expect(win).toContain('start "AI Form Assistant companion (close to stop)" /min "C:/node/node.exe" "C:/repo/companion.mjs" run');
    expect(win).not.toMatch(/runas|wscript|vbs|hidden|-WindowStyle/i);
    const unit = startupContent("systemd", "/usr/bin/node", "/srv/app/companion.mjs", "/home/u/.cfg");
    expect(unit).toMatch(/ExecStart="\/usr\/bin\/node" "\/srv\/app\/companion.mjs" run/);
    expect(unit).toMatch(/NoNewPrivileges=true/);
    expect(unit).not.toMatch(/^User=root/m);
    expect(unit).toMatch(/Environment="UFA_COMPANION_HOME=\/home\/u\/.cfg"/);
  });
});
