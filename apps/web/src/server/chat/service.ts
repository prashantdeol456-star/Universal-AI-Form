import "server-only";
import { analyzeMessage, ChatLocalAIExtractor, maskSensitiveText, replies, type ChatLanguage, type MessageAnalysis } from "@ufa/ai";
import { formatFieldValue, getFieldDef, maskValue } from "@ufa/shared";
import type { TransactionSql } from "@ufa/db";
import { asUser, type Actor } from "../db";
import { normalizeValue, readStored, storeValue } from "../documents/conflicts";
import { env } from "../env";
import { conflict, notFound } from "../http";
import { updateFieldTx } from "../profile/service";
import type { ChatMessageView, ChatProposalView, ChatSessionDetail, ChatSessionSummary, ProposalKind, SendMessageResult } from "./types";

/**
 * AI chat assistant (spec §14–16).
 *  - Understands facts the user states (rules first, optional local model).
 *  - Never writes the profile directly: each fact becomes a proposal the user accepts.
 *  - Detects conflicts with stored values and asks before replacing them.
 *  - Answers questions from the stored profile ("memory").
 * Sensitive identifiers are masked in stored chat text; proposal values are encrypted.
 */

function localAi(): ChatLocalAIExtractor | null {
  const e = env();
  return e.LOCAL_AI_ENABLED ? new ChatLocalAIExtractor({ baseUrl: e.LOCAL_AI_BASE_URL, model: e.LOCAL_AI_MODEL, apiKey: e.LOCAL_AI_API_KEY }) : null;
}

const isSensitive = (fieldKey: string) => (getFieldDef(fieldKey)?.sensitivity ?? "normal") !== "normal";
const display = (fieldKey: string, plain: string) => (isSensitive(fieldKey) ? maskValue(plain) : formatFieldValue(fieldKey, plain));

interface ProfileRow {
  field_key: string;
  value: string;
  is_encrypted: boolean;
  verified: boolean;
}

async function loadProfile(tx: TransactionSql, userId: string): Promise<Map<string, { value: string; verified: boolean }>> {
  const rows = await tx<ProfileRow[]>`
    select field_key, value, is_encrypted, verified from profile_fields where user_id = ${userId} and deleted_at is null`;
  return new Map(rows.map((r) => [r.field_key, { value: readStored(r), verified: r.verified }]));
}

interface ProposalRow {
  id: string;
  reply_id: string | null;
  field_key: string;
  value: string;
  is_encrypted: boolean;
  previous_value: string | null;
  kind: ProposalKind;
  status: ChatProposalView["status"];
  method: "rules" | "local_ai";
  confidence: string | null;
}

function toProposalView(p: ProposalRow): ChatProposalView {
  const def = getFieldDef(p.field_key);
  const prev = p.previous_value === null ? null : readStored({ value: p.previous_value, is_encrypted: p.is_encrypted });
  return {
    id: p.id,
    fieldKey: p.field_key,
    label: def?.label.en ?? p.field_key,
    labelHi: def?.label.hi ?? null,
    value: display(p.field_key, readStored(p)),
    previousValue: prev === null ? null : display(p.field_key, prev),
    kind: p.kind,
    status: p.status,
    method: p.method,
    confidence: p.confidence === null ? null : Number(p.confidence),
  };
}

async function loadMessages(tx: TransactionSql, sessionId: string, onlyIds?: string[]): Promise<ChatMessageView[]> {
  const msgs = onlyIds
    ? await tx<{ id: string; role: "user" | "assistant"; content: string; created_at: Date }[]>`
        select id, role, content, created_at from chat_messages where id in ${tx(onlyIds)} order by created_at, role desc`
    : await tx<{ id: string; role: "user" | "assistant"; content: string; created_at: Date }[]>`
        select id, role, content, created_at from chat_messages where session_id = ${sessionId} order by created_at, role desc limit 500`;
  const ids = msgs.map((m) => m.id);
  const props = ids.length
    ? await tx<ProposalRow[]>`
        select id, reply_id, field_key, value, is_encrypted, previous_value, kind, status, method, confidence
          from chat_proposals where reply_id in ${tx(ids)} order by created_at`
    : [];
  return msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at.toISOString(),
    proposals: props.filter((p) => p.reply_id === m.id).map(toProposalView),
  }));
}

// --- Sessions ----------------------------------------------------------------------

export async function listSessions(actor: Actor): Promise<ChatSessionSummary[]> {
  return asUser(actor, async (tx) => {
    const rows = await tx<{ id: string; title: string | null; updated_at: Date }[]>`
      select id, title, updated_at from chat_sessions where user_id = ${actor.id} and deleted_at is null
       order by updated_at desc limit 50`;
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString() }));
  });
}

export async function getSession(actor: Actor, id: string): Promise<ChatSessionDetail> {
  return asUser(actor, async (tx) => {
    const [s] = await tx<{ id: string; title: string | null; updated_at: Date }[]>`
      select id, title, updated_at from chat_sessions where id = ${id} and user_id = ${actor.id} and deleted_at is null`;
    if (!s) throw notFound("Conversation not found");
    return { id: s.id, title: s.title, updatedAt: s.updated_at.toISOString(), messages: await loadMessages(tx, s.id) };
  });
}

export async function deleteSession(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`update chat_sessions set deleted_at = now() where id = ${id} and user_id = ${actor.id} and deleted_at is null returning id`;
    if (!rows.length) throw notFound("Conversation not found");
    // Unanswered proposals of a deleted conversation must not linger.
    await tx`update chat_proposals set status = 'SUPERSEDED', resolved_at = now() where session_id = ${id} and status = 'PENDING'`;
  });
}

// --- Messages --------------------------------------------------------------------

function buildSummary(lang: ChatLanguage, profile: Map<string, { value: string; verified: boolean }>): string {
  const lines = [...profile.entries()]
    .filter(([key]) => getFieldDef(key))
    .slice(0, 40)
    .map(([key, v]) => {
      const def = getFieldDef(key)!;
      return `• ${lang === "hi" ? def.label.hi : def.label.en}: ${display(key, v.value)}${v.verified ? "" : " *"}`;
    });
  return [replies.summaryIntro(lang, lines.length), ...lines].join("\n");
}

async function recordAiUsage(tx: TransactionSql, actor: Actor, analysis: MessageAnalysis, latencyMs: number) {
  if (!analysis.localAiUsed && !analysis.localAiError) return;
  await tx`
    insert into ai_requests (user_id, provider, model, operation, latency_ms, success, error_code, fallback_used)
    values (${actor.id}, 'local', ${env().LOCAL_AI_MODEL}, 'chat_extract_profile', ${latencyMs}, ${analysis.localAiUsed},
            ${analysis.localAiError ? "local_ai_error" : null}, false)`;
}

export async function sendMessage(actor: Actor, input: { sessionId?: string | null; content: string }): Promise<SendMessageResult> {
  const started = Date.now();
  const analysis = await analyzeMessage(input.content, localAi());
  const latencyMs = Date.now() - started;
  const masked = maskSensitiveText(input.content, analysis.facts);
  const lang = analysis.language;

  return asUser(actor, async (tx) => {
    let sessionId = input.sessionId ?? null;
    if (sessionId) {
      const [s] = await tx`select 1 from chat_sessions where id = ${sessionId} and user_id = ${actor.id} and deleted_at is null`;
      if (!s) throw notFound("Conversation not found");
    } else {
      const [s] = await tx<{ id: string }[]>`
        insert into chat_sessions (user_id, title) values (${actor.id}, ${masked.text.slice(0, 60)}) returning id`;
      sessionId = s!.id;
    }

    const [userMsg] = await tx<{ id: string }[]>`
      insert into chat_messages (session_id, user_id, role, content, metadata)
      values (${sessionId}, ${actor.id}, 'user', ${masked.text},
              ${tx.json({ language: lang, intent: analysis.intent, masked: masked.masked, facts: analysis.facts.length })})
      returning id`;

    const profile = await loadProfile(tx, actor.id);
    const proposalIds: string[] = [];
    let text: string;

    if (analysis.intent === "UPDATE") {
      const lines: string[] = [];
      let actionable = 0;
      for (const f of analysis.facts) {
        const existing = profile.get(f.fieldKey);
        const kind: ProposalKind = !existing ? "NEW" : normalizeValue(existing.value) === normalizeValue(f.value) ? "SAME" : "UPDATE";
        // A newer statement about the same field replaces any unanswered older proposal.
        await tx`update chat_proposals set status = 'SUPERSEDED', resolved_at = now()
                  where user_id = ${actor.id} and field_key = ${f.fieldKey} and status = 'PENDING'`;
        const stored = storeValue(f.fieldKey, f.value);
        const prev = existing ? storeValue(f.fieldKey, existing.value).value : null;
        const [p] = await tx<{ id: string }[]>`
          insert into chat_proposals (user_id, session_id, message_id, field_key, value, is_encrypted, previous_value, confidence, method, kind, status)
          values (${actor.id}, ${sessionId}, ${userMsg!.id}, ${f.fieldKey}, ${stored.value}, ${stored.is_encrypted}, ${prev},
                  ${f.confidence}, ${f.method}, ${kind}, ${kind === "SAME" ? "INFO" : "PENDING"})
          returning id`;
        proposalIds.push(p!.id);
        if (kind === "NEW") {
          actionable++;
          lines.push(`• ${replies.newValue(lang, f.fieldKey, display(f.fieldKey, f.value))}`);
        } else if (kind === "UPDATE") {
          actionable++;
          lines.push(`• ${replies.conflict(lang, f.fieldKey, display(f.fieldKey, existing!.value), display(f.fieldKey, f.value))}`);
        } else {
          lines.push(`• ${replies.alreadyKnown(lang, f.fieldKey, display(f.fieldKey, f.value))}`);
        }
      }
      text = actionable ? [replies.proposalsIntro(lang, actionable), ...lines].join("\n") : lines.join("\n");
    } else if (analysis.intent === "QUERY") {
      text = analysis.queryFields
        .map((key) => {
          const v = profile.get(key);
          return replies.answer(lang, key, v ? display(key, v.value) : null, v?.verified ?? false);
        })
        .join("\n");
    } else if (analysis.intent === "SUMMARY") {
      text = buildSummary(lang, profile);
    } else if (analysis.intent === "HELP") {
      text = replies.help(lang);
    } else {
      text = replies.unknown(lang);
    }

    const [reply] = await tx<{ id: string }[]>`
      insert into chat_messages (session_id, user_id, role, content, metadata)
      values (${sessionId}, ${actor.id}, 'assistant', ${text}, ${tx.json({ intent: analysis.intent, proposals: proposalIds, localAi: analysis.localAiUsed })})
      returning id`;
    if (proposalIds.length) await tx`update chat_proposals set reply_id = ${reply!.id} where id in ${tx(proposalIds)}`;
    await tx`update chat_sessions set updated_at = now() where id = ${sessionId}`;
    await recordAiUsage(tx, actor, analysis, latencyMs);

    return { sessionId, messages: await loadMessages(tx, sessionId, [userMsg!.id, reply!.id]) };
  });
}

// --- Proposals ------------------------------------------------------------------

async function resolveOne(tx: TransactionSql, actor: Actor, p: ProposalRow & { message_id: string }, accept: boolean, ip?: string) {
  if (!accept) {
    await tx`update chat_proposals set status = 'REJECTED', resolved_at = now() where id = ${p.id}`;
    return;
  }
  const res = await updateFieldTx(
    tx,
    actor,
    // UPDATE proposals were explicitly phrased as "replace X with Y?" — accepting is the overwrite confirmation.
    { fieldKey: p.field_key, value: readStored(p), confirmOverwrite: p.kind === "UPDATE" },
    { source: "chat", userConfirmed: true, confidence: 1, sourceChatMessageId: p.message_id, reason: "chat_confirmed", ip },
  );
  if (res.status === "conflict") {
    throw conflict(`Your profile now has "${res.currentValue}" for this field. Tell me again if you want to change it.`);
  }
  await tx`update chat_proposals set status = 'SAVED', resolved_at = now() where id = ${p.id}`;
}

export async function resolveProposal(actor: Actor, proposalId: string, accept: boolean, ip?: string): Promise<ChatProposalView> {
  return asUser(actor, async (tx) => {
    const [p] = await tx<(ProposalRow & { message_id: string })[]>`
      select id, reply_id, message_id, field_key, value, is_encrypted, previous_value, kind, status, method, confidence
        from chat_proposals where id = ${proposalId} and user_id = ${actor.id} for update`;
    if (!p) throw notFound("Suggestion not found");
    if (p.status !== "PENDING") throw conflict(p.status === "SUPERSEDED" ? "A newer message replaced this suggestion" : "Already answered");
    await resolveOne(tx, actor, p, accept, ip);
    return toProposalView({ ...p, status: accept ? "SAVED" : "REJECTED" });
  });
}

/** "Save all": accepts every pending NEW value of one reply. Updates of existing values always need an individual decision. */
export async function acceptAllNew(actor: Actor, replyId: string, ip?: string): Promise<{ saved: number }> {
  return asUser(actor, async (tx) => {
    const rows = await tx<(ProposalRow & { message_id: string })[]>`
      select id, reply_id, message_id, field_key, value, is_encrypted, previous_value, kind, status, method, confidence
        from chat_proposals where reply_id = ${replyId} and user_id = ${actor.id} and status = 'PENDING' and kind = 'NEW'
       for update`;
    for (const p of rows) await resolveOne(tx, actor, p, true, ip);
    return { saved: rows.length };
  });
}
