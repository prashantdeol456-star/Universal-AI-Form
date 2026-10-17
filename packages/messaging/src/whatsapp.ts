/**
 * WhatsApp chat exports (AI browser Phase 5). Personal WhatsApp has no API for reading one's
 * own chats: the WhatsApp Business Platform only serves business numbers. So personal chats
 * come in only as the user's own "Export chat → Without media" .txt file, parsed here.
 * Nothing logs in to WhatsApp, reads WhatsApp Web, or touches the phone's database.
 *
 * Supported layouts (as exported by the apps):
 *   Android  "31/12/23, 9:15 pm - Asha: Hello"      (also 24 h, 4-digit years, "." or "-" in dates)
 *   iOS      "[31/12/23, 9:15:42 PM] Asha: Hello"
 * Lines that do not start a message continue the previous one.
 */
export const CHAT_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  messages: 20_000,
  messageChars: 4_000,
  nameChars: 80,
} as const;

export type ChatMessageKind = "text" | "media_omitted" | "deleted" | "system";

export interface ParsedChatMessage {
  seq: number;
  /** ISO time (local time of the phone, stored as given, interpreted as UTC) or null when the date was impossible. */
  at: string | null;
  /** Null for system lines ("Messages and calls are end-to-end encrypted…"). */
  sender: string | null;
  text: string;
  kind: ChatMessageKind;
}

export interface ParsedChat {
  format: "android" | "ios";
  dateOrder: "dmy" | "mdy";
  messages: ParsedChatMessage[];
  participants: Array<{ name: string; messages: number }>;
  truncated: boolean;
  /** Lines that looked broken and were kept as continuation text. */
  firstDate: string | null;
  lastDate: string | null;
}

export class ChatExportError extends Error {
  constructor(
    public readonly code: "too_large" | "not_text" | "not_an_export" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "ChatExportError";
  }
}

const ANDROID = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\s+[-–]\s+([\s\S]*)$/i;
const IOS = /^\[(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+([\s\S]*)$/i;

const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\u202f\u00a0]/g, " ");

function kindOf(text: string): ChatMessageKind {
  const t = text.trim().toLowerCase();
  if (/^<media omitted>$|^(image|video|audio|sticker|gif|document) omitted$|^<attached: .+>$/.test(t)) return "media_omitted";
  if (/^(this message was deleted|you deleted this message)$/.test(t)) return "deleted";
  return "text";
}

/** Parses the text of an export. Throws ChatExportError when it is not a WhatsApp export. */
export function parseChatExport(raw: string, opts: { dateOrder?: "dmy" | "mdy" | "auto" } = {}): ParsedChat {
  if (raw.length > CHAT_LIMITS.fileBytes) throw new ChatExportError("too_large", "The chat export is larger than 5 MB");
  if (raw.includes("\u0000")) throw new ChatExportError("not_text", "This is not a text file");
  const lines = clean(raw.replace(/^\ufeff/, "")).split(/\r?\n/);
  type Head = { d1: number; d2: number; y: number; h: number; min: number; s: number; ampm: string | null; rest: string };
  const heads: Array<Head | null> = [];
  let android = 0;
  let ios = 0;
  for (const line of lines) {
    const a = ANDROID.exec(line);
    const i = a ? null : IOS.exec(line);
    const m = a ?? i;
    if (!m) {
      heads.push(null);
      continue;
    }
    if (a) android++;
    else ios++;
    heads.push({ d1: +m[1]!, d2: +m[2]!, y: +m[3]!, h: +m[4]!, min: +m[5]!, s: m[6] ? +m[6] : 0, ampm: m[7] ? m[7].replace(/[.\s]/g, "").toLowerCase() : null, rest: m[8]! });
  }
  const starts = heads.filter(Boolean) as Head[];
  if (starts.length === 0) throw new ChatExportError("not_an_export", "This does not look like a WhatsApp chat export (Export chat → Without media → .txt)");

  let dateOrder: "dmy" | "mdy" = opts.dateOrder && opts.dateOrder !== "auto" ? opts.dateOrder : "dmy";
  if (!opts.dateOrder || opts.dateOrder === "auto") {
    if (starts.some((h) => h.d2 > 12)) dateOrder = "mdy";
    if (starts.some((h) => h.d1 > 12)) dateOrder = "dmy";
  }

  const toIso = (h: Head): string | null => {
    const day = dateOrder === "dmy" ? h.d1 : h.d2;
    const month = dateOrder === "dmy" ? h.d2 : h.d1;
    const year = h.y < 100 ? 2000 + h.y : h.y;
    let hour = h.h;
    if (h.ampm === "pm" && hour < 12) hour += 12;
    if (h.ampm === "am" && hour === 12) hour = 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || h.min > 59 || year < 2009 || year > 2100) return null;
    const d = new Date(Date.UTC(year, month - 1, day, hour, h.min, h.s));
    return d.getUTCDate() === day ? d.toISOString() : null;
  };

  const messages: ParsedChatMessage[] = [];
  let truncated = false;
  for (let n = 0; n < lines.length; n++) {
    const h = heads[n];
    if (!h) {
      // Continuation of the previous message.
      const last = messages.at(-1);
      if (last && lines[n] !== undefined && last.kind !== "system") last.text = `${last.text}\n${lines[n]}`.slice(0, CHAT_LIMITS.messageChars);
      continue;
    }
    if (messages.length >= CHAT_LIMITS.messages) {
      truncated = true;
      break;
    }
    const sep = h.rest.indexOf(": ");
    const name = sep > 0 && sep <= CHAT_LIMITS.nameChars ? h.rest.slice(0, sep).trim() : null;
    const text = (name ? h.rest.slice(sep + 2) : h.rest).slice(0, CHAT_LIMITS.messageChars);
    messages.push({ seq: messages.length + 1, at: toIso(h), sender: name, text, kind: name ? kindOf(text) : "system" });
  }
  for (const m of messages) m.text = m.text.trimEnd();
  const real = messages.filter((m) => m.sender);
  if (!real.length) throw new ChatExportError("empty", "The export has no messages");
  const counts = new Map<string, number>();
  for (const m of real) counts.set(m.sender!, (counts.get(m.sender!) ?? 0) + 1);
  const dated = messages.map((m) => m.at).filter((x): x is string => x !== null);
  return {
    format: ios > android ? "ios" : "android",
    dateOrder,
    messages,
    participants: [...counts].map(([name, n]) => ({ name, messages: n })).sort((a, b) => b.messages - a.messages),
    truncated,
    firstDate: dated[0] ?? null,
    lastDate: dated.at(-1) ?? null,
  };
}

export interface ChatLine {
  ref: string;
  sender: string | null;
  fromMe: boolean;
  at: string | null;
  text: string;
  kind: ChatMessageKind;
}

/** Messages after the user's last message (what is waiting for a reply), and the questions among them. */
export function pendingForMe(lines: ChatLine[]): { waiting: ChatLine[]; questions: ChatLine[]; needsReply: boolean } {
  const lastMine = lines.map((l) => l.fromMe).lastIndexOf(true);
  const waiting = lines.slice(lastMine + 1).filter((l) => !l.fromMe && l.kind === "text");
  return { waiting, questions: waiting.filter((l) => /\?|\b(kya|kab|kaise|kahan|kyun|when|what|where|how|can you|could you|please)\b/i.test(l.text)), needsReply: waiting.length > 0 };
}
