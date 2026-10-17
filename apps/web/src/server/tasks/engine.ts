import "server-only";
import { createHash } from "node:crypto";
import { COMPOSE_LANGUAGES, COMPOSE_TONES } from "@ufa/ai";
import { checkUrl, sameOrigin } from "@ufa/form-engine";
import { createTaskEngine, TaskError, type ApprovalSpec, type JsonObject, type ServerStepHandler, type TaskEngine, type TaskTemplate } from "@ufa/tasks";
import { z } from "zod";
import { draftAnswer, saveAnswer } from "../agent/service";
import { composeEmail } from "../compose/service";
import { db, decryptValue, encryptValue } from "../db";
import { approveDraftInTx, createApprovedGmailDraft } from "../messaging/drafts";
import { draftReply, recipientsSha, summarizeConversation } from "../messaging/intelligence";

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

// Phase 5: conversations. Inputs carry only references (thread / chat ids), never message text.
const gmailThreadId = z.string().regex(/^[0-9a-f]{6,32}$/i, "Not a Gmail thread id");
const replyTone = z.enum(["professional", "friendly", "concise", "formal"]).default("professional");
const replyInstruction = z.string().trim().max(600).transform(stripSecrets).nullish().transform((v) => v || null);
const emailThreadInput = z.object({ threadId: gmailThreadId });
type EmailThreadInput = z.infer<typeof emailThreadInput>;
const emailReplyInput = z.object({ threadId: gmailThreadId, instruction: replyInstruction, tone: replyTone, jobId: z.uuid().nullish().transform((v) => v ?? null) });
type EmailReplyInput = z.infer<typeof emailReplyInput>;
const chatInput = z.object({ chatId: z.uuid() });
type ChatInput = z.infer<typeof chatInput>;
const chatReplyInput = z.object({ chatId: z.uuid(), instruction: replyInstruction, tone: replyTone });
type ChatReplyInput = z.infer<typeof chatReplyInput>;

/** Read + fill steps of one page of a form (fill is not safe to repeat blindly). */
const pageSteps = (n: number) => [
  { key: `read_${n}`, type: "browser.read_page" as const, title: n === 1 ? "Read the form on the page" : `Read page ${n}`, idempotent: true, sequence: 2 * n - 2, input: { page: n } },
  { key: `fill_${n}`, type: "browser.fill_fields" as const, title: n === 1 ? "Fill the approved fields" : `Fill page ${n}`, idempotent: false, sequence: 2 * n - 1, input: { page: n } },
];

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
    parse: (input) => {
      const parsed = parseWith(fillFormInput)(input);
      const c = checkUrl(parsed.url);
      if (!c.ok) throw new TaskError("invalid_input", c.reason);
      return parsed;
    },
    defaultTitle: (i) => `Fill form: ${new URL((i as FillFormInput).url).hostname}`,
    steps: () => [...pageSteps(1), { key: "review", type: "approval.confirm_submission", title: "You review and submit the form yourself", sequence: 1000 }],
    // Page N is added only after the user moved there themselves, and only on the same site.
    nextPage: (i, n, url) => {
      if (!sameOrigin((i as FillFormInput).url, url)) throw new TaskError("invalid_input", `This page is on a different website (${checkUrl(url).ok ? new URL(url).hostname : "invalid address"}); the task stays on ${new URL((i as FillFormInput).url).hostname}`);
      return pageSteps(n);
    },
  } satisfies TaskTemplate<FillFormInput>,
  summarize_email_thread: {
    parse: parseWith(emailThreadInput),
    defaultTitle: () => "Summarise an email conversation",
    steps: () => [{ key: "summary", type: "server.summarize_conversation", title: "Read the thread and summarise it", input: { source: "gmail" } }],
  } satisfies TaskTemplate<EmailThreadInput>,
  draft_email_reply: {
    parse: parseWith(emailReplyInput),
    defaultTitle: () => "Draft an email reply",
    steps: () => [
      { key: "draft", type: "server.draft_reply", title: "Write the reply draft", input: { source: "gmail" } },
      { key: "approve", type: "approval.create_gmail_draft", title: "Approve creating it as a Gmail draft (not sent)" },
      // Contacts Google: never repeated blindly; an unknown outcome pauses the task for the user to check Gmail.
      { key: "create", type: "server.create_gmail_draft", title: "Create the draft in Gmail", idempotent: false },
    ],
  } satisfies TaskTemplate<EmailReplyInput>,
  summarize_whatsapp_conversation: {
    parse: parseWith(chatInput),
    defaultTitle: () => "Summarise a WhatsApp chat",
    steps: () => [{ key: "summary", type: "server.summarize_conversation", title: "Read the imported chat and summarise it", input: { source: "whatsapp" } }],
  } satisfies TaskTemplate<ChatInput>,
  draft_whatsapp_reply: {
    parse: parseWith(chatReplyInput),
    defaultTitle: () => "Draft a WhatsApp reply",
    // No sending channel exists for exported chats: the user copies the draft into WhatsApp.
    steps: () => [{ key: "draft", type: "server.draft_reply", title: "Write the reply draft (you copy and send it yourself)", input: { source: "whatsapp" } }],
  } satisfies TaskTemplate<ChatReplyInput>,
};

const conversationRef = (ctx: Parameters<ServerStepHandler>[0]) => {
  const source = ctx.stepInput.source === "whatsapp" ? "whatsapp" : "gmail";
  const ref = String(source === "gmail" ? ctx.taskInput.threadId : ctx.taskInput.chatId);
  return { source, ref } as const;
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
  // Results hold ids and counts only; summaries and drafts live in their own (deletable, encrypted) tables.
  "server.summarize_conversation": async (ctx) => {
    const { source, ref } = conversationRef(ctx);
    const s = await summarizeConversation({ id: ctx.userId, role: ctx.role }, source, ref, ctx.taskId);
    return {
      result: { insightId: s.id, provider: s.engine.provider, reason: s.engine.reason, needsReply: s.needsReply, actionItems: s.actionItems.length, questions: s.questions.length },
      message: s.engine.provider === "rules" ? "Summarised with rules (no AI)" : `Summarised with ${s.engine.provider === "local" ? "the local model" : "Gemini"}`,
    };
  },
  "server.draft_reply": async (ctx) => {
    const { source, ref } = conversationRef(ctx);
    const input = ctx.taskInput as EmailReplyInput | ChatReplyInput;
    const d = await draftReply({ id: ctx.userId, role: ctx.role }, {
      source,
      ref,
      instruction: input.instruction,
      tone: input.tone,
      jobId: "jobId" in input ? input.jobId : null,
      // One draft per task: a re-run returns the same draft.
      idempotencyKey: `task:${ctx.taskId}`,
      taskId: ctx.taskId,
    });
    return {
      result: {
        draftId: d.id,
        recipientsSha: recipientsSha(d.recipients),
        recipientCount: d.recipients.length,
        provider: d.meta?.engine.provider ?? null,
        reason: d.meta?.engine.reason ?? null,
        missing: d.meta?.missing.length ?? 0,
        unsupported: d.meta?.unsupported.length ?? 0,
      },
      message: "Draft written. Review and edit it before approving.",
    };
  },
  "server.create_gmail_draft": async (ctx) => {
    const draftId = String((ctx.previous.draft?.result as JsonObject | null)?.draftId ?? "");
    const r = await createApprovedGmailDraft({ id: ctx.userId, role: ctx.role }, draftId);
    return { result: { gmailDraftId: r.gmailDraftId, reused: r.reused }, message: r.reused ? "The Gmail draft already existed; no duplicate was created" : "Draft created in Gmail. It was not sent." };
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
  "approval.create_gmail_draft": {
    actionType: "gmail.create_draft",
    summary: (ctx) => {
      const n = Number((ctx.previous.draft?.result as JsonObject | null)?.recipientCount ?? 0);
      return `Create your reply as a DRAFT in Gmail, to ${n} recipient${n === 1 ? "" : "s"} shown on the draft, with the text as it is when you approve. It is not sent; you send it from Gmail yourself.`;
    },
    // Bound to the draft and its recipients: different recipients need a new approval.
    payload: (ctx) => {
      const r = (ctx.previous.draft?.result as JsonObject | null) ?? {};
      return { draftId: String(r.draftId ?? ""), recipientsSha: String(r.recipientsSha ?? "") };
    },
    // Database only: freezes the approved text; the Gmail call is the next (non-repeatable) step.
    effect: async (ctx, tx) => {
      const r = (ctx.previous.draft?.result as JsonObject | null) ?? {};
      const a = await approveDraftInTx(tx, ctx.userId, String(r.draftId ?? ""), String(r.recipientsSha ?? ""));
      return { approved: a.approved };
    },
  },
  "approval.confirm_submission": {
    actionType: "form.review_before_submit",
    summary: (ctx) => `Check the filled form on ${new URL((ctx.taskInput as FillFormInput).url).hostname} and submit it yourself. Approving only closes this task; nothing is submitted for you.`,
    // Bound to the site and the number of filled pages: a page added later needs a new approval.
    payload: (ctx) => ({ origin: new URL((ctx.taskInput as FillFormInput).url).origin, pages: Object.keys(ctx.previous).filter((k) => k.startsWith("fill_")).length }),
  },
};

const g = globalThis as unknown as { __ufaTasks?: TaskEngine };

export function tasks(): TaskEngine {
  g.__ufaTasks ??= createTaskEngine({ db: db(), templates, serverHandlers, approvals, encrypt: encryptValue, decrypt: decryptValue });
  return g.__ufaTasks;
}
