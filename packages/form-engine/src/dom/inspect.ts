import { injectionSignals, type InjectionSignal } from "../injection";
import { buttonRole } from "../policy";
import { safePageUrl } from "../text";
import type { FormSnapshot } from "../types";
import { detectForm, isVisible, textOf } from "./detect";

/**
 * Structured, size-limited view of the current page for the side panel (AI browser
 * Phase 2). It never reads cookies, storage, password values or the page's own scripts,
 * and it does not send whole-page text anywhere: only labels/types go on to mapping.
 * Page text is untrusted: it is scanned for instructions aimed at AI assistants, and a
 * flagged field is never filled automatically (manual = "suspicious").
 */
export interface PageInspection {
  url: string;
  origin: string;
  title: string;
  headings: string[];
  instructions: string[];
  forms: Array<{
    index: number;
    /** Where the form sends data, when it says so; flagged when it is another website. */
    actionOrigin: string | null;
    crossOrigin: boolean;
    fieldIds: string[];
    buttons: Array<{ text: string; role: ReturnType<typeof buttonRole> }>;
  }>;
  /** Visible fields only; hidden ones are counted, not offered. */
  snapshot: FormSnapshot;
  hiddenFieldCount: number;
  injection: Array<InjectionSignal & { where: "visible_text" | "hidden_text" | "label" }>;
  /** Links on the page using dangerous schemes (javascript:, data:, vbscript:). */
  dangerousLinks: number;
  truncated: boolean;
}

export const INSPECT_LIMITS = { headings: 10, headingChars: 120, instructions: 5, instructionChars: 220, buttons: 8, buttonChars: 60, hiddenTextChars: 5000, visibleTextChars: 20_000 } as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function hiddenText(doc: Document): string {
  // Text a person cannot see but a model reading the DOM could: classic place for injected instructions.
  const parts: string[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>("body *")) {
    if (parts.join(" ").length > INSPECT_LIMITS.hiddenTextChars) break;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"].includes(el.tagName)) continue;
    if (el.children.length) continue;
    const t = (el.textContent ?? "").trim();
    if (t.length < 15) continue;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    const offscreen = /-\d{4,}px/.test(`${el.style.left} ${el.style.top} ${el.style.textIndent}`);
    const tiny = style && (style.fontSize === "0px" || style.opacity === "0");
    if (!isVisible(el) || offscreen || tiny) parts.push(t);
  }
  return parts.join(" ").slice(0, INSPECT_LIMITS.hiddenTextChars);
}

export function inspectPage(doc: Document): PageInspection {
  const full = detectForm(doc);
  const visibleFields = full.fields.filter((f) => f.visible);
  const url = full.url || safePageUrl(doc.location?.href ?? "");
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  })();

  const headings = [...doc.querySelectorAll("h1, h2, h3, legend")]
    .filter((h) => isVisible(h))
    .map((h) => clip(textOf(h, 300), INSPECT_LIMITS.headingChars))
    .filter(Boolean)
    .slice(0, INSPECT_LIMITS.headings);

  const instructions = [...doc.querySelectorAll("p, li, .instructions, [role=note]")]
    .filter((p) => isVisible(p) && /\b(please|required|must|note|instructions?|upload|format|only|maximum|minimum|ensure)\b|कृपया|अनिवार्य/i.test(p.textContent ?? ""))
    .map((p) => clip(textOf(p, 400), INSPECT_LIMITS.instructionChars))
    .filter((t) => t.length > 8)
    .slice(0, INSPECT_LIMITS.instructions);

  const fieldIdsIn = (form: Element) => visibleFields.filter((f) => form.querySelector(`[data-ufa-id="${f.id}"]`)).map((f) => f.id);
  const forms = [...doc.querySelectorAll("form")].slice(0, 20).map((form, index) => {
    let actionOrigin: string | null = null;
    const action = form.getAttribute("action");
    if (action) {
      try {
        actionOrigin = new URL(action, doc.location?.href).origin;
      } catch {
        actionOrigin = null;
      }
    }
    const buttons = [...form.querySelectorAll<HTMLElement>("button, input[type=submit], input[type=button], [role=button]")]
      .filter((b) => isVisible(b))
      .map((b) => {
        const text = clip(((b as HTMLInputElement).value || b.textContent || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(), INSPECT_LIMITS.buttonChars);
        // A form button that submits (type=submit, or a <button> with no type) is a submit button whatever its text says.
        const role = buttonRole(text);
        const submits = (b.tagName === "BUTTON" || b.tagName === "INPUT") && (b as HTMLButtonElement).type === "submit";
        return { text, role: role === "other" && submits ? ("submit" as const) : role };
      })
      .filter((b) => b.text)
      .slice(0, INSPECT_LIMITS.buttons);
    return { index, actionOrigin, crossOrigin: Boolean(actionOrigin && origin && actionOrigin !== origin), fieldIds: fieldIdsIn(form), buttons };
  });

  const visibleText = (doc.body?.innerText ?? doc.body?.textContent ?? "").slice(0, INSPECT_LIMITS.visibleTextChars);
  const injection: PageInspection["injection"] = [
    ...injectionSignals(visibleText).map((s) => ({ ...s, where: "visible_text" as const })),
    ...injectionSignals(hiddenText(doc)).map((s) => ({ ...s, where: "hidden_text" as const })),
    ...visibleFields.filter((f) => f.manual === "suspicious").map((f) => ({ reason: "a field label gives orders to AI assistants", excerpt: clip(f.label, 140), where: "label" as const })),
  ].slice(0, 10);

  const dangerousLinks = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => /^\s*(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? "")).length;

  return {
    url,
    origin,
    title: clip(doc.title ?? "", 200),
    headings,
    instructions,
    forms,
    snapshot: { ...full, fields: visibleFields },
    hiddenFieldCount: full.fields.length - visibleFields.length,
    injection,
    dangerousLinks,
    truncated: full.warnings.some((w) => w.code === "too_many_fields"),
  };
}
