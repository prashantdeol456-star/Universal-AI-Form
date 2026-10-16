import { beforeEach, describe, expect, it, vi } from "vitest";

// No database, no network: the database, router and env are replaced.
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  profile: { cloud_ai_enabled: true },
  job: { title: "Project Manager", description: "Requirements\n• 5+ years of experience in project management\n• Hands-on with Jira and stakeholder reporting every week across teams" } as { title: string; description: string } | null,
  stored: [] as unknown[],
  sent: [] as unknown[],
  local: null as null | { model: string; analyzeJob: ReturnType<typeof vi.fn> },
  gemini: { model: "gemini-test", analyzeJob: vi.fn() },
  mode: "hybrid" as "hybrid" | "local_only",
}));
vi.mock("../db", () => ({
  asUser: async (_a: unknown, fn: (tx: unknown) => unknown) => {
    const tx = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (/from job_listings/.test(sql)) return state.job ? [state.job] : [];
        if (/from profiles/.test(sql)) return [state.profile];
        if (/count\(\*\)/.test(sql)) return [{ n: 0 }];
        if (/update job_listings set ai_analysis/.test(sql)) state.stored.push(values[0]);
        return [];
      },
      { json: (v: unknown) => v },
    );
    return fn(tx);
  },
}));
vi.mock("../env", () => ({ env: () => ({ COMPOSE_DAILY_LIMIT: 30 }) }));
vi.mock("../ai/router", async () => {
  const { ModelRouter } = await import("@ufa/ai");
  return { modelRouter: () => new ModelRouter({ mode: state.mode, local: state.local as never, gemini: state.gemini as never }) };
});

const { analyzeJob } = await import("./analysis");
const actor = { id: "00000000-0000-4000-8000-000000000001", role: "CUSTOMER" } as never;
const JOB = "00000000-0000-4000-8000-0000000000aa";
const good = JSON.stringify({ summary: "PM role.", responsibilities: [], requirements: [{ text: "5+ years", quote: "5+ years of experience in project management", kind: "required" }] });

beforeEach(() => {
  state.profile = { cloud_ai_enabled: true };
  state.job = { title: "Project Manager", description: "Requirements\n• 5+ years of experience in project management\n• Hands-on with Jira and stakeholder reporting every week across teams" };
  state.stored = [];
  state.local = null;
  state.mode = "hybrid";
  state.gemini.analyzeJob = vi.fn(async (input: unknown) => {
    state.sent.push(input);
    return { raw: good, usage: { inputTokens: 1, outputTokens: 1 } };
  });
});

describe("AI job analysis consent and fallbacks", () => {
  it("cloud: sends only the job title and description, stores a checked summary", async () => {
    const v = await analyzeJob(actor, JOB);
    expect(v).toMatchObject({ provider: "gemini", requirements: [{ kind: "required" }], dropped: 0 });
    expect(Object.keys(state.gemini.analyzeJob.mock.calls[0]![0] as object).sort()).toEqual(["description", "title"]);
    expect(state.stored).toHaveLength(1);
  });

  it("cloud AI switched off: refused, nothing sent", async () => {
    state.profile.cloud_ai_enabled = false;
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ status: 409, code: "ai_no_consent" });
    expect(state.gemini.analyzeJob).not.toHaveBeenCalled();
  });

  it("local-only server without a local model: refused", async () => {
    state.mode = "local_only";
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ code: "ai_local_only" });
    expect(state.gemini.analyzeJob).not.toHaveBeenCalled();
  });

  it("local model first; a local failure never falls back to the cloud", async () => {
    state.local = { model: "llama-test", analyzeJob: vi.fn(async () => ({ raw: good })) };
    expect((await analyzeJob(actor, JOB)).provider).toBe("local");
    state.local.analyzeJob = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ code: "ai_failed" });
    expect(state.gemini.analyzeJob).not.toHaveBeenCalled();
  });

  it("invalid output is discarded and nothing is stored", async () => {
    state.gemini.analyzeJob = vi.fn(async () => ({ raw: "not json at all" }));
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ code: "ai_invalid_output" });
    expect(state.stored).toHaveLength(0);
  });

  it("another user's job (not found under RLS) and too-short descriptions", async () => {
    state.job = null;
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ status: 404 });
    state.job = { title: "x", description: "Apply now" };
    await expect(analyzeJob(actor, JOB)).rejects.toMatchObject({ code: "too_little_text" });
  });
});
