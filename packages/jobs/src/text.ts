/** Text helpers for job content (HTML from providers is never rendered, only converted to plain text). */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML → plain text: block tags become line breaks, list items get "• ", scripts and styles
 * are dropped with their content, every other tag is removed. Output is bounded.
 */
export function htmlToText(html: string, max: number): string {
  const t = html
    .replace(/<(script|style|noscript|iframe|object|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/?(p|div|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return tidy(decodeEntities(t)).slice(0, max);
}

export function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // A list directly under its heading: no blank line before a bullet.
    .replace(/\n\n+(?=• )/g, "\n")
    .trim();
}

/** Stable URL for de-duplication: https, lower-case host, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|gh_src|lever-source|source$|ref$|referrer|fbclid|gclid|trk|refid|trackingid)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function detectArrangement(...texts: Array<string | null | undefined>): "remote" | "hybrid" | "onsite" | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|anywhere)\b/.test(t)) return "remote";
  if (/\b(on-?site|in[- ]office|office[- ]based)\b/.test(t)) return "onsite";
  return null;
}

export function clip(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}
