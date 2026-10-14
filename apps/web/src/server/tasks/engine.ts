import "server-only";
import { createHash } from "node:crypto";
import { COMPOSE_LANGUAGES, COMPOSE_TONES } from "@ufa/ai";
import { createTaskEngine, TaskError, type ApprovalSpec, type JsonObject, type ServerStepHandler, type TaskEngine, type TaskTemplate } from "@ufa/tasks";
import { z } from "zod";
import { draftAnswer, saveAnswer } from "../agent/service";
import { composeEmail } from "../compose/service";
import { db, decryptValue, encryptValue } from "../db";

/**
 * Task types and step handlers of the web app (AI browser Phase 1). Server steps reuse
 * existing services (email drafting, answer drafting) and never contact anyone: no email
 * is sent, nothing is submitted. Approval effects only write the user's own data.
 * Browser steps (fill_form) wait for the extension, which runs them in a later phase.
 */

/** Task inputs never keep passwords, OTPs, PINs or card codes, even if typed into an instruction. */
const stripSecrets = (s: string) => s.replace(/\b(password|passcode|otp|pin|cvv|token)\b(\s*(is|:|=|-)?\s*)\S+/gi, "$1$2[removed]");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function parseWith<T extends JsonObject>(schema: z.ZodType<T>) {
  return (input: unknown): T => {
    const r = schema.safeParse(input);
    if (!r.success) throw new TaskError("invalid_input", r.error.issues[0]?.message ?? "Invalid task input");
    return r.data;
  };
}

const draftEmailInput = z.object({
  instruction: z.string().trim().min(3).max(1000).transform(stripSecrets),
  tone: z.enum(COMPOSE_TONES).default("formal"),
  language: z.enum(COMPOSE_LANGUAGES).default("en"),
});
type DraftEmailInput = z.infer<typeof draftEmailInput>;

const draftAnswersInput = z.object({
  questions: z.array(z.string().trim().min(3).max(500).transform(stripSecrets)).min(1).max(10),
  role: z.string().trim().max(120).nullish().transform((v) => v ?? null),
});
type DraftAnswersInput = z.infer<typeof draftAnswersInput>;

const fillFormInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
type FillFormInput = z.infer<typeof fillFormInput>;

const templates: Record<string, TaskTemplate> = {
  draft_email: {
    parse: parseWith(draftEmailInput),
    defaultTitle: (i) => `Email: ${(i as DraftEmailInput).instruction.slice(0, 80)}`,
    steps: () => [
      { key: "draft", type: "server.compose_email", title: "Write the email draft" },
      { key: "review", type: "approval.accept_email_draft", title: "Approve the draft (it is not sent)" },
    ],
  } satisfies TaskTemplate<DraftEmailInput>,
  draft_answers: {
    parse: parseWith(draftAnswersInput),
    defaultTitle: (i) => `Answers: ${(i as DraftAnswersInput).questions.length} question(s)`,
    steps: (i) => [
      ...(i as DraftAnswersInput).questions.map((q, n) => ({ key: `answer_${n + 1}`, type: "server.draft_answer" as const, title: `Draft: ${q.slice(0, 120)}`, input: { question: q } })),
      { key: "save", type: "approval.save_answers", title: "Save the answers for future forms" },
    ],
  } satisfies TaskTemplate<DraftAnswersInput>,
  fill_form: {
    parse: parseWith(fillFormInput),
    defaultTitle: (i) => `Fill form: ${new URL((i as FillFormInput).url).hostname}`,
    steps: () => [
      { key: "read", type: "browser.read_page", title: "Read the form on the page", idempotent: true },
      { key: "fill", type: "browser.fill_fields", title: "Fill the fields", idempotent: false },
      { key: "submit", type: "approval.confirm_submission", title: "You review and submit the form yourself" },
    ],
  } satisfies TaskTemplate<FillFormInput>,
};

const serverHandlers: Record<string, ServerStepHandler> = {
  "server.compose_email": async (ctx) => {
    const input = ctx.taskInput as DraftEmailInput;
    const r = await composeEmail({ id: ctx.userId, role: ctx.role }, { instruction: input.instruction, tone: input.tone, language: input.language });
    return {
      result: { source: r.source, notice: r.notice, missing: r.missing.map((m) => m.label) },
      // Subject and body contain the user's own details: stored encrypted.
      secret: JSON.stringify({ subject: r.subject, body: r.body }),
      message: r.source === "gemini" ? "Draft written with AI" : "Draft written from a template",
    };
  },
  "server.draft_answer": async (ctx) => {
    const question = String(ctx.stepInput.question ?? "");
    const r = await draftAnswer({ id: ctx.userId, role: ctx.role }, { question, role: (ctx.taskInput as DraftAnswersInput).role });
    if (!r.answer.trim()) throw new Error(r.missing[0] ?? "Nothing in your profile to write this answer from");
    return { result: { source: r.source, missing: r.missing }, secret: r.answer };
  },
};

const answersOf = (ctx: Parameters<ServerStepHandler>[0]) =>
  Object.entries(ctx.previous)
    .filter(([key, v]) => key.startsWith("answer_") && v.secret)
    .map(([key, v]) => ({ key, answer: v.secret! }));

const approvals: Record<string, ApprovalSpec> = {
  "approval.accept_email_draft": {
    actionType: "email_draft.accept",
    summary: () => "Mark this email draft as ready to use. Nothing is sent.",
    payload: (ctx) => ({ draftSha256: hash(ctx.previous.draft?.secret ?? "") }),
  },
  "approval.save_answers": {
    actionType: "saved_answers.write",
    summary: (ctx) => `Save ${answersOf(ctx).length} drafted answer(s) to your Saved Answers`,
    payload: (ctx) => ({ answers: answersOf(ctx).map((a) => ({ key: a.key, sha256: hash(a.answer) })) }),
    effect: async (ctx, tx) => {
      const questions = new Map((ctx.taskInput as DraftAnswersInput).questions.map((q, n) => [`answer_${n + 1}`, q]));
      const list = answersOf(ctx);
      for (const a of list) await saveAnswer({ id: ctx.userId, role: ctx.role }, { question: questions.get(a.key)!, answer: a.answer }, tx);
      return { saved: list.length };
    },
  },
  "approval.confirm_submission": {
    actionType: "form.review_before_submit",
    summary: (ctx) => `Review the filled form on ${new URL((ctx.taskInput as FillFormInput).url).hostname}; you submit it yourself`,
    payload: (ctx) => ({ url: (ctx.taskInput as FillFormInput).url }),
  },
};

const g = globalThis as unknown as { __ufaTasks?: TaskEngine };

export function tasks(): TaskEngine {
  g.__ufaTasks ??= createTaskEngine({ db: db(), templates, serverHandlers, approvals, encrypt: encryptValue, decrypt: decryptValue });
  return g.__ufaTasks;
}
