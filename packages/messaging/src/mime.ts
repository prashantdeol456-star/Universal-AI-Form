/**
 * Email content helpers (AI browser Phase 5). Message bodies are untrusted data: HTML is
 * reduced to text (scripts, styles, images and links' targets dropped), quoted history is
 * separated from the new text, and every size is bounded. Nothing is executed or rendered.
 */
export const MAIL_LIMITS = {
  /** Characters kept per message body after cleaning. */
  bodyChars: 8_000,
  /** Messages kept from a thread (the most recent ones). */
  threadMessages: 20,
  /** Characters of a whole thread given to a model. */
  threadChars: 40_000,
  /** Search results per page. */
  pageSize: 20,
  subjectChars: 300,
  draftBodyChars: 20_000,
} as const;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return tidy(
    decodeEntities(
      html
        .replace(/<(script|style|head|noscript|iframe|object|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<li\b[^>]*>/gi, "\n• ")
        .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
        .replace(/<\/?(p|div|ul|ol|h[1-6]|tr|table|section|blockquote)\b[^>]*>/gi, "\n")
        // Inline formatting disappears without adding spaces ("on <b>21 October</b>?").
        .replace(/<\/?(b|i|u|em|strong|span|a|font|small|big|sup|sub|mark|abbr|code)\b[^>]*>/gi, "")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

export function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n+(?=• )/g, "\n")
    .trim();
}

/** Base64url (Gmail) → UTF-8 text. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function encodeBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Splits a plain-text body into the new part and the quoted history ("On … wrote:", lines
 * starting with ">", Outlook "-----Original Message-----" / "From: … Sent:" blocks).
 */
export function splitQuoted(text: string): { fresh: string; quoted: string } {
  const lines = text.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (/^On .{4,200}wrote:$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || (/^From: .+/i.test(l) && /^(Sent|Date): .+/i.test(lines[i + 1]?.trim() ?? ""))) {
      cut = i;
      break;
    }
    if (l.startsWith(">") && lines.slice(i).every((x) => !x.trim() || x.trim().startsWith(">"))) {
      cut = i;
      break;
    }
  }
  return { fresh: tidy(lines.slice(0, cut).join("\n")), quoted: tidy(lines.slice(cut).join("\n")) };
}

/** "Asha Verma <asha@example.test>, b@x.test" → addresses (lower case), invalid parts dropped. */
export function parseAddressList(header: string | null | undefined): Array<{ name: string | null; email: string }> {
  if (!header) return [];
  const out: Array<{ name: string | null; email: string }> = [];
  for (const part of header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part) ?? /^\s*()([^\s<>]+@[^\s<>]+)\s*$/.exec(part);
    if (!m) continue;
    const email = m[2]!.trim().toLowerCase();
    if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(email)) continue;
    out.push({ name: m[1]?.trim() || null, email });
  }
  return out;
}

/** Encodes a header value with RFC 2047 when it is not plain ASCII; refuses line breaks (header injection). */
export function headerValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("Header values cannot contain line breaks");
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/**
 * A reply as an RFC 5322 message for the Gmail drafts API. Recipients come only from the
 * server's reading of the thread (never from model output); threading headers keep the
 * draft in the same conversation.
 */
export function buildReplyMime(input: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo: string | null; references: string | null }): string {
  const addrs = (list: string[]) => {
    for (const a of list) if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(a)) throw new Error("Invalid recipient address");
    return list.join(", ");
  };
  if (!input.to.length) throw new Error("A reply needs a recipient");
  const lines = [
    `To: ${addrs(input.to)}`,
    ...(input.cc?.length ? [`Cc: ${addrs(input.cc)}`] : []),
    `Subject: ${headerValue(input.subject.slice(0, MAIL_LIMITS.subjectChars))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${headerValue(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${headerValue(input.references.slice(0, 2000))}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body.slice(0, MAIL_LIMITS.draftBodyChars).replace(/\r?\n/g, "\r\n"), "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  ];
  return lines.join("\r\n");
}

export const replySubject = (s: string | null) => {
  const subject = (s ?? "").trim();
  return /^re:/i.test(subject) ? subject : `Re: ${subject || "(no subject)"}`;
};
