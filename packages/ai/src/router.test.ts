import { describe, expect, it } from "vitest";
import { GeminiProvider } from "./providers/gemini";
import { LocalAIProvider } from "./providers/local";
import { AI_PURPOSES, IMPLEMENTED_PURPOSES, ModelRouter, PurposeNotImplementedError } from "./router";

const gemini = new GeminiProvider({ apiKey: "test-key", model: "m", fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
const local = new LocalAIProvider({ baseUrl: "http://localhost:11434", model: "x" });

describe("ModelRouter", () => {
  it("declares all roadmap purposes but only implements the migrated ones", () => {
    expect(AI_PURPOSES).toContain("understand_whatsapp");
    expect([...IMPLEMENTED_PURPOSES].sort()).toEqual(["draft_answer", "draft_email", "draft_whatsapp_reply", "extract_facts", "map_fields", "match_job", "plan_task", "review_task_result", "summarize_local_document", "understand_email", "understand_whatsapp"]);
    const r = new ModelRouter({ mode: "hybrid", local, gemini });
    expect(r.cloud("understand_screen", { consent: true })).toEqual({ allowed: false, reason: "not_implemented" });
    expect(() => r.local("learn_workflow")).toThrow(PurposeNotImplementedError);
    expect(() => r.cloudAvailable("understand_document")).toThrow(PurposeNotImplementedError);
  });

  it("hybrid: cloud only with consent and within budget", () => {
    const r = new ModelRouter({ mode: "hybrid", local, gemini });
    expect(r.cloud("draft_email", { consent: false })).toEqual({ allowed: false, reason: "no_consent" });
    expect(r.cloud("draft_email", { consent: true, usedToday: 30, dailyLimit: 30 })).toEqual({ allowed: false, reason: "over_budget" });
    const ok = r.cloud("draft_email", { consent: true, usedToday: 29, dailyLimit: 30 });
    expect(ok.allowed && ok.provider).toBe(gemini);
    expect(r.cloudAvailable("draft_answer")).toBe(true);
    expect(r.local("map_fields")).toBe(local);
  });

  it("local_only never returns a cloud provider, even with consent", () => {
    const r = new ModelRouter({ mode: "local_only", local, gemini });
    expect(r.cloud("draft_answer", { consent: true })).toEqual({ allowed: false, reason: "local_only" });
    expect(r.cloudAvailable("map_fields")).toBe(false);
    expect(r.local("map_fields")).toBe(local);
  });

  it("reports a missing cloud configuration before looking at consent", () => {
    const r = new ModelRouter({ mode: "cloud_enabled", local: null, gemini: null });
    expect(r.cloud("draft_email", { consent: true })).toEqual({ allowed: false, reason: "not_configured" });
    expect(r.local("draft_email")).toBeNull();
  });
});
