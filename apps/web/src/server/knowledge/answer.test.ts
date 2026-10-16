import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "./types";

// Server modules are replaced: no database, no network.
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  profile: { cloud_ai_enabled: true, ai_profile_sharing: false },
  inserts: [] as string[],
  retrieval: null as unknown as RetrievalResult,
  local: null as null | { model: string; answerFromEvidence: ReturnType<typeof vi.fn> },
  gemini: { model: "gemini-test", answerFromEvidence: vi.fn() },
  mode: "hybrid" as "hybrid" | "local_only",
}));
vi.mock("../db", () => ({
  asUser: async (_actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (/from profiles/.test(sql)) return [state.profile];
      if (/count\(\*\)/.test(sql)) return [{ n: 0 }];
      if (/insert into ai_requests/.test(sql)) state.inserts.push(sql);
      return [];
    }),
}));
vi.mock("../env", () => ({ env: () => ({ COMPOSE_DAILY_LIMIT: 30 }) }));
vi.mock("./retrieval", () => ({ retrieve: async () => state.retrieval }));
vi.mock("../ai/router", async () => {
  const { ModelRouter } = await import("@ufa/ai");
  return { modelRouter: () => new ModelRouter({ mode: state.mode, local: state.local as never, gemini: state.gemini as never }) };
});

const { answerFromKnowledge } = await import("./answer");
const actor = { id: "00000000-0000-4000-8000-000000000001", role: "CUSTOMER" } as never;

const excerpt = (ref: string, cloudAiAllowed: boolean, text = "Senior Project Manager at Acme Logistics, 2019 - 2023. Led a team of 12.") => ({
  ref,
  documentId: "d1",
  documentTitle: "cv.pdf",
  documentType: "resume",
  page: 2,
  section: "Work Experience",
  text,
  score: 3,
  cloudAiAllowed,
});
const goodReply = JSON.stringify({
  summary: "I was a Senior Project Manager at Acme Logistics.",
  not_found: false,
  statements: [{ text: "Senior Project Manager at Acme Logistics.", refs: ["S1"], quote: "Senior Project Manager at Acme Logistics" }],
});

beforeEach(() => {
  state.profile = { cloud_ai_enabled: true, ai_profile_sharing: false };
  state.inserts = [];
  state.local = null;
  state.mode = "hybrid";
  state.gemini.answerFromEvidence = vi.fn(async () => ({ raw: goodReply, usage: { inputTokens: 1, outputTokens: 1 } }));
  state.retrieval = { status: "found", query: "q", excerpts: [excerpt("S1", true)], facts: [], conflicts: [] };
});

describe("answers from the knowledge base", () => {
  it("not found: says so and never calls a model", async () => {
    state.retrieval = { status: "not_found", query: "q", excerpts: [], facts: [], conflicts: [] };
    const r = await answerFromKnowledge(actor, { question: "What is my PhD topic?" });
    expect(r).toMatchObject({ status: "not_found", summary: null, engine: { reason: "no_evidence" } });
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("conflicting sources: asks the user instead of answering", async () => {
    state.retrieval.conflicts = [{ key: "education.highest_qualification", label: "Highest Qualification", values: [] }];
    const r = await answerFromKnowledge(actor, { question: "highest qualification" });
    expect(r.status).toBe("conflict");
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("cloud: answers only from documents the user allowed, with checked quotes", async () => {
    const r = await answerFromKnowledge(actor, { question: "project management experience" });
    expect(r.status).toBe("answered");
    expect(r.engine.provider).toBe("gemini");
    expect(r.statements).toHaveLength(1);
    expect(state.inserts).toHaveLength(1);
  });

  it("cloud: a document without cloud consent is never sent", async () => {
    state.retrieval.excerpts = [excerpt("S1", false)];
    const r = await answerFromKnowledge(actor, { question: "project management experience" });
    expect(r).toMatchObject({ status: "excerpts_only", engine: { reason: "cloud_not_allowed_for_these_documents" } });
    expect(r.excerpts).toHaveLength(1);
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("cloud: only consented excerpts are included when some are allowed", async () => {
    state.retrieval.excerpts = [excerpt("S1", true), excerpt("S2", false, "Secret salary details 25 LPA")];
    await answerFromKnowledge(actor, { question: "experience" });
    const sent = state.gemini.answerFromEvidence.mock.calls[0]![0] as { excerpts: Array<{ ref: string; text: string }> };
    expect(sent.excerpts.map((e) => e.ref)).toEqual(["S1"]);
  });

  it("cloud AI switched off by the user: no cloud call", async () => {
    state.profile.cloud_ai_enabled = false;
    const r = await answerFromKnowledge(actor, { question: "experience" });
    expect(r).toMatchObject({ status: "excerpts_only", engine: { reason: "no_consent" } });
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("local-only server without a local model: no cloud call", async () => {
    state.mode = "local_only";
    const r = await answerFromKnowledge(actor, { question: "experience" });
    expect(r).toMatchObject({ status: "excerpts_only", engine: { reason: "local_only" } });
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("local model: may read documents without cloud consent; a local failure never falls back to the cloud", async () => {
    state.retrieval.excerpts = [excerpt("S1", false)];
    state.local = { model: "llama-test", answerFromEvidence: vi.fn(async () => ({ raw: goodReply })) };
    expect((await answerFromKnowledge(actor, { question: "experience" })).engine.provider).toBe("local");
    state.local.answerFromEvidence = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const r = await answerFromKnowledge(actor, { question: "experience" });
    expect(r).toMatchObject({ status: "excerpts_only", engine: { provider: "local", reason: "provider_error" } });
    expect(state.gemini.answerFromEvidence).not.toHaveBeenCalled();
  });

  it("invalid JSON or invented facts end in plain excerpts", async () => {
    state.gemini.answerFromEvidence = vi.fn(async () => ({ raw: "I think you worked at Google", usage: { inputTokens: 1, outputTokens: 1 } }));
    expect(await answerFromKnowledge(actor, { question: "experience" })).toMatchObject({ status: "excerpts_only", summary: null, engine: { reason: "invalid_model_output" } });
    state.gemini.answerFromEvidence = vi.fn(async () => ({
      raw: JSON.stringify({ summary: "Engineering Manager at Google.", not_found: false, statements: [{ text: "Google", refs: ["S1"], quote: "Engineering Manager at Google" }] }),
    }));
    expect(await answerFromKnowledge(actor, { question: "experience" })).toMatchObject({ status: "excerpts_only", summary: null, engine: { reason: "model_found_no_support", dropped: 1 } });
  });

  it("never sends sensitive profile values to a model, and profile values only with profile sharing", async () => {
    state.retrieval.facts = [
      { key: "personal.full_name", label: "Full Name", value: "Asha Verma", sensitive: false, verified: true, source: "profile", origin: "user_input", sourceDocument: null },
      { key: "identity.aadhaar_number", label: "Aadhaar", value: "••••••••1234", sensitive: true, verified: true, source: "profile", origin: "document", sourceDocument: null },
    ];
    await answerFromKnowledge(actor, { question: "name" });
    let sent = state.gemini.answerFromEvidence.mock.calls[0]![0] as { excerpts: Array<{ ref: string }> };
    expect(sent.excerpts.map((e) => e.ref)).toEqual(["S1"]);
    state.profile.ai_profile_sharing = true;
    await answerFromKnowledge(actor, { question: "name" });
    sent = state.gemini.answerFromEvidence.mock.calls[1]![0] as { excerpts: Array<{ ref: string; text: string }> };
    expect(sent.excerpts.map((e) => e.ref)).toEqual(["S1", "P1"]);
    expect(JSON.stringify(sent)).not.toMatch(/1234/);
  });
});
