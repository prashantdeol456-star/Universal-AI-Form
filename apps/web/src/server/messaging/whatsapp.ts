import "server-only";
import { createHash } from "node:crypto";
import { decodePlainText } from "@ufa/document-engine";
import { CHAT_LIMITS, ChatExportError, parseChatExport, type ChatLine, type ChatMessageKind, type ParsedChat } from "@ufa/messaging";
import { audit } from "../audit";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { env } from "../env";
import { badRequest, conflict, HttpError, notFound } from "../http";

/**
 * WhatsApp (AI browser Phase 5). Personal chats come only from an export file the user picks
 * ("Export chat → Without media"). Nothing connects to WhatsApp. Each chat is stored encrypted,
 * scoped to the user, and deleted after its retention date. The WhatsApp Business Platform is
 * detected from configuration only; no sending is implemented.
 */
export interface WhatsAppCapabilities {
  personalChatExport: true;
  businessApi: "not_configured" | "configured_not_enabled";
  sending: false;
}

export function whatsappCapabilities(): WhatsAppCapabilities {
  const e = env();
  return {
    personalChatExport: true,
    businessApi: e.WHATSAPP_BUSINESS_PHONE_NUMBER_ID && e.WHATSAPP_BUSINESS_TOKEN ? "configured_not_enabled" : "not_configured",
    sending: false,
  };
}

function readExport(file: File, buf: Buffer): string {
  if (!/\.txt$/i.test(file.name)) throw new HttpError(415, "unsupported_type", "Upload the .txt file from WhatsApp → Export chat → Without media (a .zip must be unpacked first)");
  if (buf.length === 0) throw badRequest("The file is empty");
  if (buf.length > CHAT_LIMITS.fileBytes) throw new HttpError(413, "too_large", "The chat export is larger than 5 MB. Export a shorter period or a single chat.");
  const text = decodePlainText(buf);
  if (text === null) throw new HttpError(415, "not_text", "This file is not UTF-8 text");
  return text;
}

function parseOrThrow(text: string, dateOrder: "dmy" | "mdy" | "auto"): ParsedChat {
  try {
    return parseChatExport(text, { dateOrder });
  } catch (err) {
    if (err instanceof ChatExportError) throw new HttpError(err.code === "too_large" ? 413 : 422, `chat_${err.code}`, err.message);
    throw err;
  }
}

/** Reads the file without storing anything: who is in the chat (so the user can say which name is theirs). */
export async function previewChatExport(file: File, dateOrder: "dmy" | "mdy" | "auto" = "auto") {
  const buf = Buffer.from(await file.arrayBuffer());
  const c = parseOrThrow(readExport(file, buf), dateOrder);
  return {
    format: c.format,
    dateOrder: c.dateOrder,
    messages: c.messages.length,
    participants: c.participants.slice(0, 50),
    firstDate: c.firstDate,
    lastDate: c.lastDate,
    truncated: c.truncated,
  };
}

export interface ChatSummaryView {
  id: string;
  title: string;
  myName: string | null;
  format: "android" | "ios";
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  cloudAiAllowed: boolean;
  importedAt: string;
  expiresAt: string;
}

export async function importChat(
  actor: Actor,
  input: { file: File; title: string | null; myName: string; dateOrder: "dmy" | "mdy" | "auto"; retentionDays?: number | null },
  ip?: string,
): Promise<ChatSummaryView> {
  const buf = Buffer.from(await input.file.arrayBuffer());
  const c = parseOrThrow(readExport(input.file, buf), input.dateOrder);
  const me = input.myName.trim();
  if (!c.participants.some((p) => p.name === me)) throw badRequest("Choose which name in the chat is you");
  const others = c.participants.filter((p) => p.name !== me).map((p) => p.name);
  const title = (input.title?.trim() || others.slice(0, 3).join(", ") || "WhatsApp chat").slice(0, 120);
  const days = Math.min(Math.max(input.retentionDays ?? env().WHATSAPP_RETENTION_DAYS, 1), 365);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const id = await asUser(actor, async (tx) => {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from whatsapp_chats where user_id = ${actor.id}`;
    if (n!.n >= 50) throw badRequest("You can keep up to 50 imported chats. Delete some first.");
    const [dup] = await tx`select id from whatsapp_chats where user_id = ${actor.id} and file_sha256 = ${sha256}`;
    if (dup) throw conflict("You already imported this exact chat export");
    const [row] = await tx<{ id: string }[]>`
      insert into whatsapp_chats (user_id, title_encrypted, my_name_encrypted, file_sha256, format, date_order, message_count, first_message_at, last_message_at, expires_at)
      values (${actor.id}, ${encryptValue(title)}, ${encryptValue(me)}, ${sha256}, ${c.format}, ${c.dateOrder}, ${c.messages.length},
              ${c.firstDate}, ${c.lastDate}, now() + ${`${days} days`}::interval)
      returning id`;
    for (let i = 0; i < c.messages.length; i += 500) {
      const batch = c.messages.slice(i, i + 500).map((m) => ({
        chat_id: row!.id,
        user_id: actor.id,
        seq: m.seq,
        sent_at: m.at,
        sender_encrypted: m.sender ? encryptValue(m.sender) : null,
        from_me: m.sender === me,
        kind: m.kind,
        text_encrypted: encryptValue(m.text || " "),
      }));
      await tx`insert into whatsapp_messages ${tx(batch as never)}`;
    }
    await audit({ actorId: actor.id, actorRole: actor.role, action: "whatsapp.chat_imported", targetType: "whatsapp_chat", targetId: row!.id, subjectUserId: actor.id, ip, metadata: { messages: c.messages.length, format: c.format } }, tx);
    return row!.id;
  });
  return (await listChats(actor)).find((x) => x.id === id)!;
}

/** Expired imports are removed whenever the list is read (plus their drafts and summaries). */
async function purgeExpired(actor: Actor) {
  await asUser(actor, async (tx) => {
    const gone = await tx<{ id: string }[]>`delete from whatsapp_chats where user_id = ${actor.id} and expires_at < now() returning id`;
    if (gone.length) {
      const refs = gone.map((g) => g.id);
      await tx`delete from message_drafts where user_id = ${actor.id} and channel = 'whatsapp' and thread_ref = any(${refs}::text[])`;
      await tx`delete from message_insights where user_id = ${actor.id} and source = 'whatsapp' and ref = any(${refs}::text[])`;
    }
  });
}

export async function listChats(actor: Actor): Promise<ChatSummaryView[]> {
  await purgeExpired(actor);
  const rows = await asUser(actor, (tx) => tx<{ id: string; title_encrypted: string; my_name_encrypted: string | null; format: "android" | "ios"; message_count: number; first_message_at: Date | null; last_message_at: Date | null; cloud_ai_allowed: boolean; imported_at: Date; expires_at: Date }[]>`
    select id, title_encrypted, my_name_encrypted, format, message_count, first_message_at, last_message_at, cloud_ai_allowed, imported_at, expires_at
      from whatsapp_chats where user_id = ${actor.id} order by imported_at desc`);
  return rows.map((r) => ({
    id: r.id,
    title: decryptValue(r.title_encrypted),
    myName: r.my_name_encrypted ? decryptValue(r.my_name_encrypted) : null,
    format: r.format,
    messageCount: r.message_count,
    firstMessageAt: r.first_message_at?.toISOString() ?? null,
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    cloudAiAllowed: r.cloud_ai_allowed,
    importedAt: r.imported_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  }));
}

export interface ChatMessageView {
  ref: string;
  seq: number;
  sender: string | null;
  fromMe: boolean;
  at: string | null;
  kind: ChatMessageKind;
  text: string;
}

/** Messages of one of the user's chats, newest page last (bounded). */
export async function chatMessages(actor: Actor, chatId: string, opts: { beforeSeq?: number; limit?: number } = {}): Promise<{ chat: ChatSummaryView; messages: ChatMessageView[] }> {
  const chat = (await listChats(actor)).find((c) => c.id === chatId);
  if (!chat) throw notFound("Chat not found");
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = await asUser(actor, (tx) => tx<{ seq: number; sent_at: Date | null; sender_encrypted: string | null; from_me: boolean; kind: ChatMessageKind; text_encrypted: string }[]>`
    select seq, sent_at, sender_encrypted, from_me, kind, text_encrypted from whatsapp_messages
     where chat_id = ${chatId} and user_id = ${actor.id} ${opts.beforeSeq ? tx`and seq < ${opts.beforeSeq}` : tx``}
     order by seq desc limit ${limit}`);
  return {
    chat,
    messages: rows.reverse().map((r) => ({
      ref: `M${r.seq}`,
      seq: r.seq,
      sender: r.sender_encrypted ? decryptValue(r.sender_encrypted) : null,
      fromMe: r.from_me,
      at: r.sent_at?.toISOString() ?? null,
      kind: r.kind,
      text: decryptValue(r.text_encrypted),
    })),
  };
}

export const toChatLines = (ms: ChatMessageView[]): ChatLine[] => ms.map((m) => ({ ref: m.ref, sender: m.sender, fromMe: m.fromMe, at: m.at, text: m.text, kind: m.kind }));

export async function updateChat(actor: Actor, chatId: string, u: { cloudAiAllowed?: boolean; retentionDays?: number }, ip?: string): Promise<ChatSummaryView> {
  await asUser(actor, async (tx) => {
    const [c] = await tx`select id from whatsapp_chats where id = ${chatId} and user_id = ${actor.id}`;
    if (!c) throw notFound("Chat not found");
    if (u.cloudAiAllowed !== undefined) {
      await tx`update whatsapp_chats set cloud_ai_allowed = ${u.cloudAiAllowed} where id = ${chatId}`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: u.cloudAiAllowed ? "whatsapp.cloud_ai_allowed" : "whatsapp.cloud_ai_revoked", targetType: "whatsapp_chat", targetId: chatId, subjectUserId: actor.id, ip }, tx);
    }
    if (u.retentionDays !== undefined) await tx`update whatsapp_chats set expires_at = imported_at + ${`${Math.min(Math.max(u.retentionDays, 1), 365)} days`}::interval where id = ${chatId}`;
  });
  return (await listChats(actor)).find((c) => c.id === chatId)!;
}

/** Deletes an imported chat, its messages, drafts and summaries. */
export async function deleteChat(actor: Actor, chatId: string, ip?: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const rows = await tx`delete from whatsapp_chats where id = ${chatId} and user_id = ${actor.id} returning id`;
    if (!rows.length) throw notFound("Chat not found");
    await tx`delete from message_drafts where user_id = ${actor.id} and channel = 'whatsapp' and thread_ref = ${chatId}`;
    await tx`delete from message_insights where user_id = ${actor.id} and source = 'whatsapp' and ref = ${chatId}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "whatsapp.chat_deleted", targetType: "whatsapp_chat", targetId: chatId, subjectUserId: actor.id, ip }, tx);
  });
}
