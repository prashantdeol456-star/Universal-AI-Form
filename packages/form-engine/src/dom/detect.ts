import { MAX_FIELDS } from "../limits";
import { cleanLabel, detectLabelLanguage, fnv1a, humanizeIdentifier, manualReasonFor, normalizeLabel, safePageUrl } from "../text";
import type { FieldKind, FormSnapshot, FormWarning, NormalizedField } from "../types";

/**
 * Reads the structure of the forms on a page (spec §19–21). Deterministic DOM
 * code: no AI, no values captured, nothing sent anywhere by itself.
 */

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "search", "range", "color"]);
const NON_TEXT_TAGS = new Set(["SELECT", "OPTION", "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "BUTTON", "NOSCRIPT", "TEMPLATE", "SVG"]);
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,[role=heading],legend,caption,.section-title,.panel-heading,.card-header,.form-section-title";
export const PLACEHOLDER_OPTION = /^(?:-+\s*)?(select|choose|please\s+select|pick|--|चुनें|चयन\s*करें)\b|^-+$/i;

// --- small DOM helpers ----------------------------------------------------------------

/**
 * Realm-independent checks: iframes have their own ShadowRoot/Node classes, so
 * `instanceof` against the top window's classes would silently fail there.
 */
const DOCUMENT_POSITION_FOLLOWING = 4;
const isShadowRoot = (n: Node): n is ShadowRoot => n.nodeType === 11 && "host" in n && Boolean((n as ShadowRoot).host);

/** Escapes a value for use inside a double-quoted attribute selector. */
const esc = (v: string) => v.replace(/["\\]/g, "\\$&");

/** Visible text of an element, excluding form controls, scripts and option lists. */
export function textOf(node: Node | null, max = 300): string {
  if (!node) return "";
  let out = "";
  const walk = (n: Node) => {
    if (out.length > max) return;
    if (n.nodeType === 3) out += n.nodeValue ?? "";
    else if (n.nodeType === 1) {
      const el = n as Element;
      if (NON_TEXT_TAGS.has(el.tagName.toUpperCase()) || el.getAttribute("aria-hidden") === "true") return;
      if (el.tagName === "BR" || /^(DIV|P|LI|TR|LABEL)$/.test(el.tagName)) out += " ";
      el.childNodes.forEach(walk);
    }
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function hasControl(el: Element): boolean {
  return Boolean(el.querySelector("input:not([type=hidden]),select,textarea,[contenteditable=''],[contenteditable=true],[role=combobox]"));
}

/** Style/attribute-based visibility (no layout needed, so it also works in tests). */
export function isVisible(el: Element): boolean {
  if ((el as HTMLInputElement).type === "hidden") return false;
  const view = el.ownerDocument.defaultView;
  for (let cur: Element | null = el; cur; cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host ?? null)) {
    if (cur.hasAttribute("hidden") || cur.getAttribute("aria-hidden") === "true" || cur.hasAttribute("inert")) return false;
    const style = view?.getComputedStyle?.(cur);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    if (cur.tagName === "DETAILS" && !(cur as HTMLDetailsElement).open && cur !== el && !el.closest("summary")) return false;
  }
  return true;
}

function idsText(doc: Document | ShadowRoot, ids: string | null): string {
  if (!ids) return "";
  return ids
    .split(/\s+/)
    .map((id) => textOf(doc.getElementById(id)))
    .filter(Boolean)
    .join(" ");
}

function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  return isShadowRoot(r) || r.nodeType === 9 ? (r as Document | ShadowRoot) : el.ownerDocument;
}

// --- labels ---------------------------------------------------------------------------

interface LabelResult {
  text: string;
  source: NormalizedField["labelSource"];
  raw: string;
}

function labelsOf(el: Control): string {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return [...labels].map((l) => textOf(l)).filter(Boolean).join(" ");
  // Fallback for environments without .labels on custom elements.
  const id = el.getAttribute("id");
  if (id) {
    const l = rootOf(el).querySelector?.(`label[for="${esc(id)}"]`);
    if (l) return textOf(l);
  }
  const wrap = el.closest("label");
  return wrap ? textOf(wrap) : "";
}

/** Option text of one radio button / checkbox in a group (also used by the filler to find it again). */
export function choiceLabelOf(m: HTMLInputElement): string {
  return cleanLabel(labelsOf(m) || m.getAttribute("aria-label") || m.value);
}

/** Label from a table layout: the cell before the control's cell, or the row header. */
function tableLabel(el: Element): string {
  const cell = el.closest("td,th");
  if (!cell) return "";
  for (let prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (!hasControl(prev)) {
      const t = textOf(prev);
      if (t) return t;
    }
  }
  return "";
}

/** Short text just before the control (previous siblings, then up to 3 ancestors' previous siblings). */
function nearbyLabel(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 4; depth++) {
    // Text nodes directly before the element.
    let sib: ChildNode | null = node.previousSibling;
    while (sib) {
      if (sib.nodeType === 3 && sib.nodeValue?.trim()) return sib.nodeValue.trim();
      if (sib.nodeType === 1) {
        const e = sib as Element;
        if (hasControl(e) || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.tagName)) break;
        const t = textOf(e, 160);
        if (t && t.length <= 150) return t;
        if (t) break;
      }
      sib = sib.previousSibling;
    }
    node = node.parentElement;
    if (node && (node.tagName === "FORM" || node.tagName === "BODY" || node.tagName === "FIELDSET")) break;
    // Stop climbing once the container holds other controls (we'd pick up their labels).
    if (node && node.querySelectorAll("input:not([type=hidden]),select,textarea").length > 1) break;
  }
  return "";
}

function resolveLabel(el: Control): LabelResult {
  const pick = (raw: string, source: LabelResult["source"]): LabelResult | null => {
    const text = cleanLabel(raw);
    return text ? { text, source, raw } : null;
  };
  const root = rootOf(el);
  return (
    pick(labelsOf(el), "label") ??
    pick(idsText(root, el.getAttribute("aria-labelledby")), "aria") ??
    pick(el.getAttribute("aria-label") ?? "", "aria") ??
    pick(tableLabel(el), "table") ??
    pick(nearbyLabel(el), "nearby") ??
    pick(el.getAttribute("title") ?? "", "title") ??
    pick(el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder") ?? "", "placeholder") ??
    pick(humanizeIdentifier(el.getAttribute("name") ?? el.getAttribute("id")), "name") ?? { text: "", source: "name", raw: "" }
  );
}

/** Text inside a container that comes before its first control: "<div>Are you X? <label><input>Yes</label>…". */
function leadingText(container: Element): string {
  let out = "";
  for (const child of container.childNodes) {
    if (child.nodeType === 1) {
      const e = child as Element;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) || hasControl(e)) break;
      out += ` ${textOf(e)}`;
    } else if (child.nodeType === 3) {
      out += ` ${child.nodeValue ?? ""}`;
    }
  }
  return out.trim().length <= 200 ? out.trim() : "";
}

/** Question text for a radio/checkbox group. */
function groupLabel(first: Element): LabelResult {
  const group = first.closest("[role=radiogroup],[role=group],fieldset");
  if (group) {
    const legend = group.tagName === "FIELDSET" ? group.querySelector(":scope > legend") : null;
    const t =
      cleanLabel(textOf(legend)) ||
      cleanLabel(idsText(rootOf(group), group.getAttribute("aria-labelledby"))) ||
      cleanLabel(group.getAttribute("aria-label"));
    if (t) return { text: t, source: legend ? "legend" : "aria", raw: t };
  }
  // Climb to the container that holds the whole group, then read the text before it.
  const name = first.getAttribute("name");
  let container: Element | null = first.parentElement;
  while (container && name && container.querySelectorAll(`input[name="${esc(name)}"]`).length < 2 && container.tagName !== "FORM") {
    container = container.parentElement;
  }
  if (container) {
    const t = cleanLabel(leadingText(container) || tableLabel(container) || nearbyLabel(container));
    if (t) return { text: t, source: "nearby", raw: t };
  }
  return { text: cleanLabel(humanizeIdentifier(name)), source: "name", raw: name ?? "" };
}

// --- sections -------------------------------------------------------------------------

/** A fieldset that only wraps one radio/checkbox group is a question, not a section. */
function isQuestionFieldset(fs: Element): boolean {
  return fs.querySelectorAll("input:not([type=radio]):not([type=checkbox]),select,textarea").length === 0;
}

/** Per-scan cache (pages change between scans, so it must never outlive one detectForm call). */
type HeadingCache = Map<Document, Element[]>;

function headingsOf(doc: Document, headingCache: HeadingCache): Element[] {
  let list = headingCache.get(doc);
  if (!list) {
    list = [...doc.querySelectorAll(HEADING_SELECTOR)].filter((h) => {
      if (h.tagName === "H1") return false;
      if (h.tagName === "LEGEND" && h.parentElement && isQuestionFieldset(h.parentElement)) return false;
      const t = textOf(h);
      return t.length > 0 && t.length < 120;
    });
    headingCache.set(doc, list);
  }
  return list;
}

/** Nearest preceding heading in `doc`, measured from `anchor`. */
function precedingHeading(anchor: Element, doc: Document, cache: HeadingCache): string | null {
  let best: Element | null = null;
  for (const h of headingsOf(doc, cache)) {
    if (h.compareDocumentPosition(anchor) & DOCUMENT_POSITION_FOLLOWING && !h.contains(anchor)) best = h;
  }
  return best ? cleanLabel(textOf(best, 120)) || null : null;
}

function sectionFor(el: Element, cache: HeadingCache): string | null {
  const fs = el.closest("fieldset");
  const legend = fs?.querySelector(":scope > legend");
  if (legend && !isQuestionFieldset(fs!)) return cleanLabel(textOf(legend)) || null;

  // Headings in the field's own document/frame first; then climb out of shadow roots and
  // iframes, using the host / <iframe> element as the position in the outer document.
  let anchor: Element = el;
  for (let depth = 0; depth < 5; depth++) {
    const root = anchor.getRootNode();
    if (isShadowRoot(root)) {
      anchor = root.host;
      continue;
    }
    const doc = anchor.ownerDocument;
    const found = precedingHeading(anchor, doc, cache);
    if (found) return found;
    const frameEl = doc.defaultView?.frameElement;
    if (!frameEl) return null;
    anchor = frameEl;
  }
  return null;
}

// --- kinds, options, flags -----------------------------------------------------------------

function kindOf(el: Control): FieldKind | null {
  const tag = el.tagName;
  if (tag === "TEXTAREA") return "textarea";
  if (tag === "SELECT") return "select";
  if (tag === "INPUT") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (SKIP_INPUT_TYPES.has(t)) return null;
    if (el.getAttribute("list") || el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete")) return "combobox";
    const map: Record<string, FieldKind> = {
      email: "email", tel: "tel", number: "number", date: "date", "datetime-local": "date", month: "date",
      radio: "radio", checkbox: "checkbox", file: "file", password: "password",
    };
    return map[t] ?? "text";
  }
  if (el.getAttribute("role") === "combobox" || el.getAttribute("role") === "listbox") return "combobox";
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return "contenteditable";
  if (el.getAttribute("role") === "textbox") return "contenteditable";
  return null;
}

function optionsOf(el: Control, kind: FieldKind): string[] {
  if (el.tagName === "SELECT") {
    const opts = [...(el as HTMLSelectElement).options].map((o) => cleanLabel(o.text)).filter(Boolean);
    return opts.filter((o, i) => !(i === 0 && PLACEHOLDER_OPTION.test(o))).slice(0, 400);
  }
  if (kind === "combobox") {
    const root = rootOf(el);
    const listId = el.getAttribute("list");
    if (listId) {
      const dl = root.getElementById?.(listId) ?? el.ownerDocument.getElementById(listId);
      if (dl) return [...dl.querySelectorAll("option")].map((o) => cleanLabel(o.getAttribute("value") ?? o.textContent)).filter(Boolean).slice(0, 400);
    }
    const ctl = el.getAttribute("aria-controls") ?? el.getAttribute("aria-owns");
    const lb = ctl ? (root.getElementById?.(ctl) ?? el.ownerDocument.getElementById(ctl)) : el.querySelector("[role=listbox]");
    if (lb) return [...lb.querySelectorAll("[role=option]")].map((o) => cleanLabel(textOf(o))).filter(Boolean).slice(0, 400);
  }
  return [];
}

function hasValueOf(el: Control, kind: FieldKind): boolean {
  if (kind === "radio" || kind === "checkbox") return (el as HTMLInputElement).checked;
  if (el.tagName === "SELECT") {
    const s = el as HTMLSelectElement;
    return s.selectedIndex > 0 || (s.selectedIndex === 0 && Boolean(s.value) && !PLACEHOLDER_OPTION.test(s.options[0]?.text ?? ""));
  }
  if (kind === "file") return Boolean((el as HTMLInputElement).files?.length);
  if ("value" in el && typeof (el as HTMLInputElement).value === "string") return (el as HTMLInputElement).value.trim() !== "";
  return Boolean(el.textContent?.trim());
}

function hintOf(el: Element): string | null {
  const desc = idsText(rootOf(el), el.getAttribute("aria-describedby"));
  if (desc) return cleanLabel(desc);
  const next = el.nextElementSibling;
  if (next && /help|hint|note|error|invalid|feedback|instruction/i.test(next.className) && !hasControl(next)) return cleanLabel(textOf(next, 200)) || null;
  return null;
}

function isRequired(el: Element, rawLabel: string): boolean {
  return (
    (el as HTMLInputElement).required === true ||
    el.getAttribute("aria-required") === "true" ||
    /[*✱]/.test(rawLabel) ||
    Boolean(el.closest(".required,.mandatory,[data-required=true]"))
  );
}

function captchaNearby(el: Element): boolean {
  const box = el.closest("div,td,p,li,form") ?? el.parentElement;
  if (!box) return false;
  if (box.querySelector(".g-recaptcha,.h-captcha")) return true;
  return [...box.querySelectorAll("img,canvas,iframe")].some((e) =>
    /captcha/i.test(`${e.getAttribute("src") ?? ""} ${e.getAttribute("alt") ?? ""} ${e.getAttribute("id") ?? ""} ${e.getAttribute("class") ?? ""}`),
  );
}

// --- collection ----------------------------------------------------------------------

/** All candidate controls, including open shadow roots and same-origin iframes. */
function collect(doc: Document, onCrossOrigin: () => void): Array<{ el: Control; frame: "top" | "child"; shadow: boolean }> {
  const out: Array<{ el: Control; frame: "top" | "child"; shadow: boolean }> = [];
  const selector = "input,textarea,select,[contenteditable=''],[contenteditable=true],[role=combobox],[role=textbox],[role=listbox]";
  const visit = (root: Document | ShadowRoot, frame: "top" | "child", shadow: boolean) => {
    root.querySelectorAll<Control>(selector).forEach((el) => {
      if (el.closest("[data-ufa-ignore],form[role=search]")) return;
      // A custom combobox wrapper around a native control: use the native control.
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.querySelector("input,select,textarea")) return;
      // A listbox that belongs to a combobox is that combobox's option list, not a field.
      if (el.getAttribute("role") === "listbox" && (el.closest("[role=combobox]") || (el.id && root.querySelector(`[aria-controls="${esc(el.id)}"],[aria-owns="${esc(el.id)}"]`)))) return;
      out.push({ el, frame, shadow });
    });
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) visit(el.shadowRoot, frame, true);
    });
    root.querySelectorAll("iframe,frame").forEach((f) => {
      let inner: Document | null = null;
      try {
        inner = (f as HTMLIFrameElement).contentDocument;
      } catch {
        inner = null;
      }
      if (inner?.documentElement) visit(inner, "child", shadow);
      else if ((f as HTMLIFrameElement).src && !/^(about:|javascript:)/.test((f as HTMLIFrameElement).src)) onCrossOrigin();
    });
  };
  visit(doc, "top", false);
  return out;
}

let idCounter = 0;
function stableId(el: Element): string {
  let id = el.getAttribute("data-ufa-id");
  if (!id) {
    id = `f${++idCounter}`;
    el.setAttribute("data-ufa-id", id);
  }
  return id;
}

/**
 * The field signature of a live element, computed exactly as detectForm does. Used before
 * filling and when verifying: if a page re-used an element for another field (common in
 * single-page apps), the signature no longer matches and the element is treated as stale.
 */
export function liveSignature(el: Element): string | null {
  const kind = kindOf(el as Control);
  if (!kind) return null;
  const name = el.getAttribute("name");
  let label: LabelResult;
  if ((kind === "radio" || kind === "checkbox") && name) {
    const scope = el.closest("form") ?? rootOf(el);
    const members = [...scope.querySelectorAll<HTMLInputElement>(`input[type=${kind}][name="${esc(name)}"]`)];
    label = kind === "radio" || members.length > 1 ? groupLabel(members[0] ?? el) : resolveLabel(el as Control);
  } else {
    label = resolveLabel(el as Control);
  }
  const labelText = label.text || "(unlabelled field)";
  return fnv1a(`${kind}|${(name ?? el.getAttribute("id") ?? "").toLowerCase()}|${normalizeLabel(labelText)}`);
}

export interface DetectOptions {
  maxFields?: number;
}

export function detectForm(doc: Document, opts: DetectOptions = {}): FormSnapshot {
  const maxFields = opts.maxFields ?? MAX_FIELDS;
  const warnings: FormWarning[] = [];
  let crossOrigin = 0;
  const controls = collect(doc, () => crossOrigin++);

  const fields: NormalizedField[] = [];
  const headingCache: HeadingCache = new Map();
  const seenGroups = new Set<string>();

  for (const { el, frame, shadow } of controls) {
    if (fields.length >= maxFields) {
      warnings.push({ code: "too_many_fields", limit: maxFields });
      break;
    }
    const kind = kindOf(el);
    if (!kind) continue;
    const input = el as HTMLInputElement;
    const name = el.getAttribute("name");

    let label: LabelResult;
    let options: string[] = [];
    let groupMembers: HTMLInputElement[] = [input];

    if ((kind === "radio" || kind === "checkbox") && name) {
      const scope = el.closest("form") ?? rootOf(el);
      const members = [...scope.querySelectorAll<HTMLInputElement>(`input[type=${kind}][name="${esc(name)}"]`)];
      if (kind === "radio" || members.length > 1) {
        const groupKey = `${frame}|${kind}|${name}`;
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        groupMembers = members;
        label = groupLabel(members[0]!);
        options = members.map(choiceLabelOf).filter(Boolean);
      } else {
        label = resolveLabel(el);
      }
    } else {
      label = resolveLabel(el);
      options = optionsOf(el, kind);
    }

    const first = groupMembers[0]!;
    const extra = [name, el.getAttribute("id"), el.getAttribute("placeholder"), el.getAttribute("autocomplete")].filter(Boolean).join(" ");
    let manual: NormalizedField["manual"] = kind === "password" ? "password" : manualReasonFor(label.text, extra);
    if (!manual && (kind === "text" || kind === "number") && captchaNearby(el)) manual = "captcha";

    const visible = groupMembers.some((m) => isVisible(m));
    const labelText = label.text || "(unlabelled field)";
    fields.push({
      id: stableId(first),
      kind,
      label: labelText,
      labelSource: label.source,
      name,
      htmlId: el.getAttribute("id"),
      placeholder: el.getAttribute("placeholder"),
      section: sectionFor(first, headingCache),
      required: groupMembers.some((m) => isRequired(m, label.raw)),
      options,
      autocomplete: el.getAttribute("autocomplete"),
      inputMode: el.getAttribute("inputmode"),
      maxLength: input.maxLength > 0 ? input.maxLength : null,
      pattern: el.getAttribute("pattern"),
      hint: hintOf(el),
      language: detectLabelLanguage(labelText),
      visible,
      disabled: groupMembers.every((m) => m.disabled === true || m.getAttribute("aria-disabled") === "true"),
      readOnly: input.readOnly === true || el.getAttribute("aria-readonly") === "true",
      hasValue: groupMembers.some((m) => hasValueOf(m, kind)),
      manual,
      accept: kind === "file" ? el.getAttribute("accept") : null,
      signature: fnv1a(`${kind}|${(name ?? el.getAttribute("id") ?? "").toLowerCase()}|${normalizeLabel(labelText)}`),
      frame,
      inShadowDom: shadow,
    });
  }

  if (crossOrigin) warnings.push({ code: "cross_origin_iframes", count: crossOrigin });
  if (fields.some((f) => f.manual === "captcha")) warnings.push({ code: "captcha_present" });
  if (fields.some((f) => f.manual === "otp")) warnings.push({ code: "otp_present" });
  if (fields.length === 0) {
    warnings.push({ code: "no_fields" });
    if (doc.querySelector("canvas") || [...doc.querySelectorAll("*")].some((e) => e.tagName.includes("-") && !e.shadowRoot && e.childElementCount === 0)) {
      warnings.push({ code: "closed_or_canvas_content" });
    }
  }

  const visibleSigs = [...new Set(fields.filter((f) => f.visible).map((f) => f.signature))].sort();
  const sections = [...new Set(fields.map((f) => f.section).filter((s): s is string => Boolean(s)))];
  const h1 = doc.querySelector("h1");
  const domain = (() => {
    try {
      return new URL(doc.location?.href ?? "").hostname;
    } catch {
      return "";
    }
  })();

  return {
    url: safePageUrl(doc.location?.href ?? ""),
    domain,
    pageTitle: (doc.title ?? "").trim().slice(0, 300),
    formTitle: h1 ? cleanLabel(textOf(h1, 300)) || null : null,
    fields,
    sections,
    formSignature: fnv1a(`${domain}|${visibleSigs.join(",")}`),
    structureHash: fnv1a(fields.map((f) => `${f.kind}:${f.section ?? ""}`).join(">")),
    warnings,
    detectedAt: new Date().toISOString(),
  };
}
