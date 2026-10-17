import "server-only";
import { createHash } from "node:crypto";
import {
  ConversationReplyError,
  draftSystemPrompt,
  draftUserPrompt,
  DRAFT_SCHEMA,
  SUMMARY_SCHEMA,
  summarySystemPrompt,
  summaryUserPrompt,
  validateDraft,
  validateSummary,
  type AIPurpose,
  type ConvFact,
  type ConvMessage,
  type ConversationSummary,
  type ReplyTone,
} from "@ufa/ai";
import { pendingForMe, replyRecipients, replySubject } from "@ufa/messaging";
import { getFieldDef } from "@ufa/shared";
import { redact } from "@ufa/security";
import { modelRouter } from "../ai/router";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { readStored } from "../documents/conflicts";
import { env } from "../env";
import { badRequest, HttpError, notFound } from "../http";
import { readThread } from "./gmail";
import { chatMessages } from "./whatsapp";

/**
 * Summaries and reply drafts for one email thread or one imported WhatsApp chat (Phase 5).
 *
 * Model choice (Model Router, purposes understand_email / understand_whatsapp / draft_email /
 * draft_whatsapp_reply): a configured local model first; otherwise cloud AI only when the
 * user's cloud switch is on AND this mailbox / chat is allowed for cloud AI (both default
 * off for messages); a failed local model never falls back to the cloud. Without a model,
 * rule-based results are returned and labelled as such. Messages are bounded, and model
 * replies are validated (quotes, refs, unsupported details). Nothing is sent.
 */
export type Source = "gmail" | "whatsapp";

interface Conversation {
  source: Source;
  ref: string;
  messages: ConvMessage[];
  cloudAllowed: boolean;
  /** Gmail: whom a reply goes to (from headers), the subject and threading ids. */
  reply?: { to: string[]; subject: string; inReplyTo: string | null; references: string | null; replyToMessageRef: string | null };
  myName: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function loadConversation(actor: Actor, source: Source, ref: string): Promise<Conversation> {
  if (source === "gmail") {
    const { thread, account, session } = await readThread(actor, ref);
    const messages: ConvMessage[] = thread.messages.map((m, i) => ({
      ref: `M${i + 1}`,
      from: m.from?.email === account ? "You" : m.from ? `${m.from.name ?? m.from.email}` : "Unknown",
      at: m.date,
      text: m.body || "(no text)",
    }));
    const r = replyRecipients(thread, account);
    const idx = r.replyToMessage ? thread.messages.indexOf(r.replyToMessage) : -1;
    return {
      source,
      ref,
      messages,
      cloudAllowed: session.cloudAiAllowed,
      myName: "You",
      reply: {
        to: r.to,
        subject: replySubject(thread.subject),
        inReplyTo: r.replyToMessage?.messageIdHeader ?? null,
        references: [r.replyToMessage?.references, r.replyToMessage?.messageIdHeader].filter(Boolean).join(" ") || null,
        replyToMessageRef: idx >= 0 ? `M${idx + 1}` : null,
      },
    };
  }
  if (!/^[0-9a-f-]{36}$/i.test(ref)) throw notFound("Chat not found");
  const { chat, messages } = await chatMessages(actor, ref, { limit: 200 });
  return {
    source,
    ref,
    cloudAllowed: chat.cloudAiAllowed,
    myName: chat.myName ?? "You",
    messages: messages.filter((m) => m.kind === "text").map((m) => ({ ref: m.ref, from: m.fromMe ? "You" : m.sender ?? "Unknown", at: m.at, text: m.text })),
  };
}

type Engine = { provider: "local" | "gemini" | "rules"; reason: string | null };

async function runModel(actor: Actor, purpose: AIPurpose, cloudAllowed: boolean, system: string, user: string, schema: object): Promise<{ raw: string | null; engine: Engine }> {
  const router = modelRouter();
  const local = router.local(purpose);
  const { cloudAi, used } = await asUser(actor, async (tx) => {
    const [p] = await tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${actor.id}`;
    const [c] = await tx<{ n: number }[]>`select count(*)::int as n from ai_requests where user_id = ${actor.id} and operation = 'conversation' and success and created_at >= date_trunc('day', now())`;
    return { cloudAi: p?.cloud_ai_enabled ?? true, used: c!.n };
  });
  let provider: "local" | "gemini";
  let model: string;
  let call: () => Promise<{ raw: string; usage?: { inputTokens: number; outputTokens: number } }>;
  if (local) {
    provider = "local";
    model = local.model;
    call = () => local.generateStructured({ system, user, schema });
  } else {
    if (!cloudAllowed) return { raw: null, engine: { provider: "rules", reason: "cloud_not_allowed_for_this_conversation" } };
    const d = router.cloud(purpose, { consent: cloudAi, usedToday: used, dailyLimit: env().MESSAGES_AI_DAILY_LIMIT });
    if (!d.allowed) return { raw: null, engine: { provider: "rules", reason: d.reason } };
    provider = "gemini";
    model = d.provider.model;
    const g = d.provider;
    call = () => g.generateStructured({ system, user, schema });
  }
  const started = Date.now();
  try {
    const { raw, usage } = await call();
    await record(actor, provider, model, Date.now() - started, true, null, usage).catch(() => {});
    return { raw, engine: { provider, reason: null } };
  } catch (err) {
    console.warn(`[ai] ${provider} conversation failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    await record(actor, provider, model, Date.now() - started, false, "provider_error").catch(() => {});
    // No fallback from local to cloud (or the reverse): rules only.
    return { raw: null, engine: { provider: "rules", reason: "provider_error" } };
  }
}

async function record(actor: Actor, provider: string, model: string, latencyMs: number, success: boolean, errorCode: string | null, usage?: { inputTokens: number; outputTokens: number }) {
  await asUser(actor, (tx) => tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used, input_tokens, output_tokens)
    values (${actor.id}, ${provider}, ${model}, 'conversation', ${latencyMs}, ${success}, ${errorCode}, false, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})`);
}

// --- Summary ------------------------------------------------------------------------------

export interface InsightView extends ConversationSummary {
  id: string;
  source: Source;
  ref: string;
  engine: Engine;
  createdAt: string;
}

function rulesSummary(c: Conversation): ConversationSummary {
  const lines = c.messages.map((m) => ({ ref: m.ref, sender: m.from, fromMe: m.from === "You", at: m.at, text: m.text, kind: "text" as const }));
  const p = pendingForMe(lines);
  return {
    summary: `${c.messages.length} message(s). ${p.needsReply ? `${p.waiting.length} message(s) after your last reply are waiting for you.` : "The last message is yours."}`,
    needsReply: p.needsReply,
    actionItems: [],
    questions: p.questions.slice(0, 10).map((q) => ({ text: q.text.slice(0, 200), ref: q.ref, quote: q.text.slice(0, 200) })),
    dropped: 0,
  };
}

export async function summarizeConversation(actor: Actor, source: Source, ref: string, taskId: string | null = null): Promise<InsightView> {
  const c = await loadConversation(actor, source, ref);
  if (!c.messages.length) throw badRequest("There are no text messages to summarise");
  const purpose: AIPurpose = source === "gmail" ? "understand_email" : "understand_whatsapp";
  const { raw, engine } = await runModel(actor, purpose, c.cloudAllowed, summarySystemPrompt(), summaryUserPrompt(source === "gmail" ? "email" : "whatsapp", c.messages), SUMMARY_SCHEMA);
  let result: ConversationSummary;
  let finalEngine = engine;
  if (raw === null) result = rulesSummary(c);
  else {
    try {
      result = validateSummary(raw, c.messages);
    } catch (err) {
      if (!(err instanceof ConversationReplyError)) throw err;
      result = rulesSummary(c);
      finalEngine = { provider: "rules", reason: "invalid_model_output" };
    }
  }
  const [row] = await asUser(actor, (tx) => tx<{ id: string; created_at: Date }[]>`
    insert into message_insights (user_id, source, ref, content_encrypted, provider, task_id)
    values (${actor.id}, ${source}, ${ref}, ${encryptValue(JSON.stringify({ ...result, engine: finalEngine }))}, ${finalEngine.provider}, ${taskId})
    returning id, created_at`);
  return { id: row!.id, source, ref, ...result, engine: finalEngine, createdAt: row!.created_at.toISOString() };
}

export async function listInsights(actor: Actor, source: Source, ref: string): Promise<InsightView[]> {
  const rows = await asUser(actor, (tx) => tx<{ id: string; content_encrypted: string; created_at: Date }[]>`
    select id, content_encrypted, created_at from message_insights where user_id = ${actor.id} and source = ${source} and ref = ${ref} order by created_at desc limit 10`);
  return rows.map((r) => ({ id: r.id, source, ref, ...(JSON.parse(decryptValue(r.content_encrypted)) as ConversationSummary & { engine: Engine }), createdAt: r.created_at.toISOString() }));
}

export async function deleteInsight(actor: Actor, id: string): Promise<void> {
  const rows = await asUser(actor, (tx) => tx`delete from message_insights where id = ${id} and user_id = ${actor.id} returning id`);
  if (!rows.length) throw notFound("Summary not found");
}

// --- Reply draft ---------------------------------------------------------------------------

/** Verified, non-sensitive profile facts (and a saved job, when chosen) that may support a reply. */
async function replyFacts(actor: Actor, jobId: string | null, cloud: boolean): Promise<ConvFact[]> {
  return asUser(actor, async (tx) => {
    const [p] = await tx<{ ai_profile_sharing: boolean }[]>`select ai_profile_sharing from profiles where user_id = ${actor.id}`;
    const facts: ConvFact[] = [];
    // Profile facts go to a cloud model only with profile sharing on (same rule as answers).
    if (!cloud || p?.ai_profile_sharing) {
      const rows = await tx<{ field_key: string; value: string; is_encrypted: boolean }[]>`
        select field_key, value, is_encrypted from profile_fields
         where user_id = ${actor.id} and deleted_at is null and verified
           and field_key in ('personal.full_name', 'employment.designation', 'employment.company', 'employment.experience_years', 'employment.skills', 'education.highest_qualification', 'employment.notice_period')`;
      for (const r of rows) facts.push({ ref: `P${facts.length + 1}`, label: getFieldDef(r.field_key)?.label.en ?? r.field_key, text: readStored(r).slice(0, 300) });
    }
    if (jobId) {
      const [j] = await tx<{ title: string; employer: string | null; status: string | null; submitted_confirmed_at: Date | null }[]>`
        select j.title, j.employer, a.status, a.submitted_confirmed_at from job_listings j left join job_applications a on a.job_id = j.id
         where j.id = ${jobId} and j.user_id = ${actor.id}`;
      if (!j) throw notFound("Job not found");
      const applied = j.submitted_confirmed_at ? `you confirmed applying on ${j.submitted_confirmed_at.toISOString().slice(0, 10)}` : "no application confirmed by you";
      facts.push({ ref: "J1", label: "Saved job", text: `${j.title}${j.employer ? ` at ${j.employer}` : ""}; status: ${j.status ?? "not tracked"}; ${applied}` });
    }
    return facts;
  });
}

export interface DraftView {
  id: string;
  channel: Source;
  threadRef: string;
  status: "draft" | "approved" | "created" | "failed" | "discarded" | "copied";
  recipients: string[];
  subject: string | null;
  body: string;
  replyToRef: string | null;
  gmailDraftId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present right after drafting. */
  meta?: { engine: Engine; usedRefs: string[]; missing: string[]; unsupported: string[]; facts: ConvFact[] };
}

export async function draftReply(
  actor: Actor,
  input: { source: Source; ref: string; instruction: string | null; tone: ReplyTone; jobId?: string | null; idempotencyKey: string; taskId?: string | null },
): Promise<DraftView> {
  const existing = await asUser(actor, (tx) => tx<{ id: string }[]>`select id from message_drafts where user_id = ${actor.id} and idempotency_key = ${input.idempotencyKey}`);
  if (existing[0]) return getDraft(actor, existing[0].id);
  const c = await loadConversation(actor, input.source, input.ref);
  if (input.source === "gmail" && !c.reply?.to.length) throw new HttpError(409, "no_recipient", "There is no message from someone else in this thread to reply to");
  const instruction = input.instruction?.trim().slice(0, 600) || null;
  const purpose: AIPurpose = input.source === "gmail" ? "draft_email" : "draft_whatsapp_reply";
  const router = modelRouter();
  const facts = await replyFacts(actor, input.jobId ?? null, !router.local(purpose));
  const channel = input.source === "gmail" ? "email" : "whatsapp";
  const { raw, engine } = await runModel(actor, purpose, c.cloudAllowed, draftSystemPrompt(channel, input.tone), draftUserPrompt(channel, c.messages, facts, instruction), DRAFT_SCHEMA);
  let body = "";
  let meta: NonNullable<DraftView["meta"]> = { engine, usedRefs: [], missing: [], unsupported: [], facts };
  if (raw !== null) {
    try {
      const d = validateDraft(raw, { messages: c.messages, facts, instruction, channel });
      body = d.body;
      meta = { engine, usedRefs: d.usedRefs, missing: d.missing, unsupported: d.unsupported, facts };
    } catch (err) {
      if (!(err instanceof ConversationReplyError)) throw err;
      meta = { ...meta, engine: { provider: "rules", reason: "invalid_model_output" } };
    }
  }
  if (!body) {
    // No model (or its draft was refused): an empty frame for the user to write in.
    const name = c.messages.filter((m) => m.from !== "You").at(-1)?.from.split(/[\s(<]/)[0] ?? "";
    body = channel === "email" ? `Hi${name ? ` ${name}` : ""},\n\n[Write your reply here]\n\nRegards` : "[Write your reply here]";
    meta.missing = ["Your reply text"];
  }
  const id = await asUser(actor, async (tx) => {
    const [conn] = input.source === "gmail" ? await tx<{ id: string }[]>`select id from mail_connections where user_id = ${actor.id} and provider = 'gmail'` : [undefined];
    const [row] = await tx<{ id: string }[]>`
      insert into message_drafts (user_id, channel, connection_id, thread_ref, reply_to_ref, recipients_encrypted, subject_encrypted, body_encrypted, task_id, idempotency_key)
      values (${actor.id}, ${input.source}, ${conn?.id ?? null}, ${input.ref}, ${c.reply?.replyToMessageRef ?? null},
              ${c.reply ? encryptValue(JSON.stringify({ to: c.reply.to, inReplyTo: c.reply.inReplyTo, references: c.reply.references })) : null},
              ${c.reply ? encryptValue(c.reply.subject) : null}, ${encryptValue(body)}, ${input.taskId ?? null}, ${input.idempotencyKey})
      on conflict (user_id, idempotency_key) do nothing
      returning id`;
    if (row) return row.id;
    const [again] = await tx<{ id: string }[]>`select id from message_drafts where user_id = ${actor.id} and idempotency_key = ${input.idempotencyKey}`;
    return again!.id;
  });
  return { ...(await getDraft(actor, id)), meta };
}

interface DraftRow {
  id: string;
  channel: Source;
  thread_ref: string;
  status: DraftView["status"];
  recipients_encrypted: string | null;
  subject_encrypted: string | null;
  body_encrypted: string;
  reply_to_ref: string | null;
  gmail_draft_id: string | null;
  approved_content_sha: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function recipientsOf(r: { recipients_encrypted: string | null }): { to: string[]; inReplyTo: string | null; references: string | null } {
  return r.recipients_encrypted ? JSON.parse(decryptValue(r.recipients_encrypted)) : { to: [], inReplyTo: null, references: null };
}

function toView(r: DraftRow): DraftView {
  return {
    id: r.id,
    channel: r.channel,
    threadRef: r.thread_ref,
    status: r.status,
    recipients: recipientsOf(r).to,
    subject: r.subject_encrypted ? decryptValue(r.subject_encrypted) : null,
    body: decryptValue(r.body_encrypted),
    replyToRef: r.reply_to_ref,
    gmailDraftId: r.gmail_draft_id,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getDraft(actor: Actor, id: string): Promise<DraftView> {
  const [r] = await asUser(actor, (tx) => tx<DraftRow[]>`select * from message_drafts where id = ${id} and user_id = ${actor.id}`);
  if (!r) throw notFound("Draft not found");
  return toView(r);
}

export async function listDrafts(actor: Actor, filter: { source?: Source; ref?: string } = {}): Promise<DraftView[]> {
  const rows = await asUser(actor, (tx) => tx<DraftRow[]>`
    select * from message_drafts where user_id = ${actor.id} and status <> 'discarded'
      ${filter.source ? tx`and channel = ${filter.source}` : tx``} ${filter.ref ? tx`and thread_ref = ${filter.ref}` : tx``}
     order by created_at desc limit 100`);
  return rows.map(toView);
}

/** The user edits the text (never the recipients). Only drafts not yet approved can change. */
export async function updateDraft(actor: Actor, id: string, u: { body?: string; subject?: string; status?: "copied" | "discarded" }): Promise<DraftView> {
  await asUser(actor, async (tx) => {
    const [r] = await tx<DraftRow[]>`select * from message_drafts where id = ${id} and user_id = ${actor.id} for update`;
    if (!r) throw notFound("Draft not found");
    if (u.body !== undefined || u.subject !== undefined) {
      if (r.status !== "draft") throw new HttpError(409, "draft_locked", r.status === "approved" || r.status === "created" ? "This draft was approved; its text can no longer change" : "This draft can no longer be edited");
      if (u.body !== undefined) await tx`update message_drafts set body_encrypted = ${encryptValue(u.body.slice(0, 20_000) || " ")} where id = ${id}`;
      if (u.subject !== undefined && r.channel === "gmail") await tx`update message_drafts set subject_encrypted = ${encryptValue(u.subject.slice(0, 300))} where id = ${id}`;
    }
    if (u.status) {
      if (u.status === "copied" && r.channel !== "whatsapp") throw badRequest("Only WhatsApp drafts are copied");
      if (r.status === "created" && u.status === "discarded") throw new HttpError(409, "draft_in_gmail", "This draft already exists in Gmail; delete it there");
      await tx`update message_drafts set status = ${u.status} where id = ${id}`;
    }
  });
  return getDraft(actor, id);
}

export async function deleteDraft(actor: Actor, id: string): Promise<void> {
  const rows = await asUser(actor, (tx) => tx`delete from message_drafts where id = ${id} and user_id = ${actor.id} returning id`);
  if (!rows.length) throw notFound("Draft not found");
}

export const draftContentSha = (subject: string | null, body: string, to: string[]) => sha(JSON.stringify({ to, subject, body }));
export const recipientsSha = (to: string[]) => sha(JSON.stringify([...to].sort()));
