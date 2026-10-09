import { prepareValue, type FillInstruction, type FillReason, type FillResult } from "../fill";
import { cleanLabel } from "../text";
import type { NormalizedField } from "../types";
import { choiceLabelOf, isVisible, PLACEHOLDER_OPTION, textOf } from "./detect";
import { hideCursor, pointAt, typeProgressively } from "./visual";

/**
 * Deterministic form filler (spec §31–33). Writes only values the user
 * confirmed in the side panel, one field at a time, the way a person would
 * (native value setter + input/change events, so React/Angular/Vue pages see
 * the change). It never clicks submit, never presses Enter, never touches
 * CAPTCHA/OTP/password/file fields, and executes no code from the server or AI.
 */

export interface FillItem {
  field: NormalizedField;
  instruction: FillInstruction;
}

export interface FillRun {
  results: FillResult[];
  /** Puts every changed field back the way it was. */
  undo: () => number;
}

export interface FillOptions {
  /** How long to wait for a custom dropdown's option list to appear. */
  optionWaitMs?: number;
  /** Outline filled fields so the user can see what changed. */
  highlight?: boolean;
  /** Show the work: move a visible cursor to each field and type text letter by letter. */
  visual?: boolean;
}

const FILLED_OUTLINE = "2px solid #1a7f37";
const esc = (v: string) => v.replace(/["\\]/g, "\\$&");

/** Finds a detected field again: top document, open shadow roots, same-origin iframes. */
export function findFieldElement(doc: Document, fieldId: string): HTMLElement | null {
  const selector = `[data-ufa-id="${esc(fieldId)}"]`;
  const visit = (root: Document | ShadowRoot): HTMLElement | null => {
    const hit = root.querySelector<HTMLElement>(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const inner = visit(el.shadowRoot);
        if (inner) return inner;
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let d: Document | null = null;
        try {
          d = (el as HTMLIFrameElement).contentDocument;
        } catch {
          d = null;
        }
        const inner = d?.documentElement ? visit(d) : null;
        if (inner) return inner;
      }
    }
    return null;
  };
  return visit(doc);
}

// --- low-level writing ------------------------------------------------------------------

function fire(el: Element, type: string) {
  const W = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (!W) return;
  const Ctor = type === "input" && W.InputEvent ? W.InputEvent : W.Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, composed: true }));
}

function fireMouse(el: Element, type: string) {
  const W = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (W) el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: W }));
}

/** Uses the prototype's setter so framework value trackers notice the change. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) {
      desc.set.call(el, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  el.value = value;
}

function writeText(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  fire(el, "input");
  fire(el, "change");
  el.blur();
}

function isDisabled(el: Element): boolean {
  return (el as HTMLInputElement).disabled === true || (el as HTMLInputElement).readOnly === true || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-readonly") === "true";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- per control type -------------------------------------------------------------------

type Outcome = { status: "filled"; restore: () => void } | { status: "skipped" | "failed"; reason: FillReason };
const skip = (reason: FillReason): Outcome => ({ status: "skipped", reason });
const fail = (reason: FillReason): Outcome => ({ status: "failed", reason });

function groupMembers(first: HTMLInputElement): HTMLInputElement[] {
  const name = first.getAttribute("name");
  if (!name) return [first];
  const scope = first.closest("form") ?? (first.getRootNode() as Document | ShadowRoot);
  return [...scope.querySelectorAll<HTMLInputElement>(`input[type=${first.type}][name="${esc(name)}"]`)];
}

function fillRadio(first: HTMLInputElement, value: string, overwrite: boolean): Outcome {
  const members = groupMembers(first);
  if (!members.some((m) => isVisible(m))) return skip("hidden");
  const target = members.find((m) => choiceLabelOf(m) === value);
  if (!target) return fail("no_option");
  if (target.disabled) return skip("disabled");
  const before = members.find((m) => m.checked) ?? null;
  if (before === target) return { status: "filled", restore: () => {} };
  if (before && !overwrite) return skip("has_value");
  target.click();
  if (!target.checked) return fail("rejected_by_page");
  return {
    status: "filled",
    restore: () => {
      if (before) before.click();
      else {
        target.checked = false;
        fire(target, "change");
      }
    },
  };
}

function fillCheckbox(el: HTMLInputElement, field: NormalizedField, value: string, overwrite: boolean): Outcome {
  if (field.options.length > 1) {
    const target = groupMembers(el).find((m) => choiceLabelOf(m) === value);
    if (!target) return fail("no_option");
    if (target.disabled) return skip("disabled");
    if (target.checked) return { status: "filled", restore: () => {} };
    target.click();
    return target.checked ? { status: "filled", restore: () => target.checked && target.click() } : fail("rejected_by_page");
  }
  const want = value === "true";
  if (el.checked === want) return { status: "filled", restore: () => {} };
  if (el.checked && !overwrite) return skip("has_value");
  el.click();
  if (el.checked !== want) return fail("rejected_by_page");
  return { status: "filled", restore: () => el.checked !== !want && el.click() };
}

function fillSelect(el: HTMLSelectElement, value: string, overwrite: boolean): Outcome {
  const options = [...el.options];
  const target = options.find((o) => cleanLabel(o.text) === value);
  if (!target) return fail("no_option");
  const beforeIndex = el.selectedIndex;
  const before = options[beforeIndex];
  if (before === target) return { status: "filled", restore: () => {} };
  const hasValue = beforeIndex > 0 || (beforeIndex === 0 && Boolean(el.value) && !PLACEHOLDER_OPTION.test(before?.text ?? ""));
  if (hasValue && !overwrite) return skip("has_value");
  el.focus({ preventScroll: true });
  setNativeValue(el, target.value);
  target.selected = true;
  fire(el, "input");
  fire(el, "change");
  el.blur();
  if (el.selectedIndex !== target.index) return fail("rejected_by_page");
  return {
    status: "filled",
    restore: () => {
      el.selectedIndex = beforeIndex;
      fire(el, "input");
      fire(el, "change");
    },
  };
}

/** The option list a custom combobox controls (aria-controls / aria-owns / nested listbox). */
function listboxOf(el: HTMLElement): Element | null {
  const root = el.getRootNode() as Document | ShadowRoot;
  const id = el.getAttribute("aria-controls") ?? el.getAttribute("aria-owns");
  if (id) return root.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
  return el.closest("[role=combobox]")?.querySelector("[role=listbox]") ?? null;
}

async function fillCombobox(el: HTMLInputElement, value: string, overwrite: boolean, waitMs: number): Promise<Outcome> {
  const before = el.value;
  if (before.trim() && before.trim() !== value && !overwrite) return skip("has_value");
  // Native <datalist>: the typed text is the value.
  if (el.getAttribute("list") || !listboxOf(el)) {
    writeText(el, value);
    return el.value ? { status: "filled", restore: () => writeText(el, before) } : fail("rejected_by_page");
  }
  // ARIA combobox: type to open/filter the list, then pick the option like a user would.
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  fire(el, "input");
  const deadline = Date.now() + waitMs;
  let option: Element | undefined;
  while (!option && Date.now() <= deadline) {
    const lb = listboxOf(el);
    option = lb ? [...lb.querySelectorAll("[role=option]")].find((o) => cleanLabel(textOf(o)) === value && !o.closest("[hidden]")) : undefined;
    if (!option) await sleep(50);
  }
  if (!option) {
    writeText(el, before);
    return fail("option_not_found");
  }
  fireMouse(option, "mousedown");
  fireMouse(option, "mouseup");
  (option as HTMLElement).click();
  fire(el, "change");
  el.blur();
  return el.value.trim() ? { status: "filled", restore: () => writeText(el, before) } : fail("rejected_by_page");
}

function fillTextLike(el: HTMLInputElement | HTMLTextAreaElement, value: string, overwrite: boolean): Outcome {
  let v = value;
  // A detected "date" may be <input type=month|datetime-local>.
  if (el.tagName === "INPUT") {
    if (el.type === "month") v = value.slice(0, 7);
    else if (el.type === "datetime-local") v = `${value}T00:00`;
  }
  const before = el.value;
  if (before === v) return { status: "filled", restore: () => {} };
  if (before.trim() && !overwrite) return skip("has_value");
  writeText(el, v);
  if (!el.value) return fail("rejected_by_page");
  return { status: "filled", restore: () => writeText(el, before) };
}

/** Same checks as fillTextLike, but the text appears letter by letter (visual mode). */
async function typeTextLike(el: HTMLInputElement | HTMLTextAreaElement, value: string, overwrite: boolean): Promise<Outcome> {
  const special = el.tagName === "INPUT" && ["month", "datetime-local", "date", "time", "number", "range", "color"].includes(el.type);
  if (special) return fillTextLike(el, value, overwrite);
  const before = el.value;
  if (before === value) return { status: "filled", restore: () => {} };
  if (before.trim() && !overwrite) return skip("has_value");
  el.focus({ preventScroll: true });
  await typeProgressively(el.ownerDocument, value, (partial) => {
    setNativeValue(el, partial);
    fire(el, "input");
  });
  fire(el, "change");
  el.blur();
  if (!el.value) return fail("rejected_by_page");
  return { status: "filled", restore: () => writeText(el, before) };
}

function fillEditable(el: HTMLElement, value: string, overwrite: boolean): Outcome {
  const before = el.textContent ?? "";
  if (before.trim() && !overwrite) return skip("has_value");
  el.focus({ preventScroll: true });
  el.textContent = value;
  fire(el, "input");
  el.blur();
  return {
    status: "filled",
    restore: () => {
      el.textContent = before;
      fire(el, "input");
    },
  };
}

async function fillOne(doc: Document, item: FillItem, opts: Required<FillOptions>): Promise<Outcome> {
  const { field, instruction: ins } = item;
  const prepared = prepareValue(field, ins);
  if (!prepared.ok) return skip(prepared.reason);

  const el = findFieldElement(doc, field.id);
  if (!el) return fail("not_found");
  const tag = el.tagName;
  const type = (el as HTMLInputElement).type?.toLowerCase();

  // Re-check on the live element: the page may have changed since detection.
  if (type === "password" || type === "file" || type === "hidden") return skip("not_fillable");
  if (field.kind === "radio") return fillRadio(el as HTMLInputElement, prepared.value, ins.overwrite);
  if (!isVisible(el)) return skip("hidden");
  if (isDisabled(el)) return skip("disabled");

  if (field.kind === "checkbox") return fillCheckbox(el as HTMLInputElement, field, prepared.value, ins.overwrite);
  if (tag === "SELECT") return fillSelect(el as HTMLSelectElement, prepared.value, ins.overwrite);
  if (field.kind === "combobox" && tag === "INPUT") return fillCombobox(el as HTMLInputElement, prepared.value, ins.overwrite, opts.optionWaitMs);
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return opts.visual ? typeTextLike(el as HTMLInputElement, prepared.value, ins.overwrite) : fillTextLike(el as HTMLInputElement, prepared.value, ins.overwrite);
  }
  if (el.isContentEditable || el.getAttribute("contenteditable") !== null) return fillEditable(el, prepared.value, ins.overwrite);
  return skip("not_fillable");
}

function markFilled(el: HTMLElement | null): () => void {
  if (!el) return () => {};
  const prev = el.style.outline;
  el.style.outline = FILLED_OUTLINE;
  el.setAttribute("data-ufa-filled", "1");
  return () => {
    el.style.outline = prev;
    el.removeAttribute("data-ufa-filled");
  };
}

/**
 * Fills confirmed items in page order. Dependent fields (state after country)
 * work because each change event runs before the next field is looked at.
 */
export async function fillForm(doc: Document, items: FillItem[], options: FillOptions = {}): Promise<FillRun> {
  const opts: Required<FillOptions> = { optionWaitMs: options.optionWaitMs ?? 1500, highlight: options.highlight ?? true, visual: options.visual ?? false };
  const results: FillResult[] = [];
  const restores: Array<() => void> = [];
  for (const item of items) {
    let outcome: Outcome;
    try {
      if (opts.visual) {
        const target = findFieldElement(doc, item.field.id);
        if (target && isVisible(target)) await pointAt(target);
      }
      outcome = await fillOne(doc, item, opts);
    } catch {
      outcome = fail("error");
    }
    if (outcome.status === "filled") {
      const unmark = opts.highlight ? markFilled(findFieldElement(doc, item.field.id)) : () => {};
      const restore = outcome.restore;
      restores.push(() => {
        restore();
        unmark();
      });
      results.push({ fieldId: item.field.id, status: "filled" });
    } else {
      results.push({ fieldId: item.field.id, status: outcome.status, reason: outcome.reason });
    }
  }
  if (opts.visual) hideCursor(doc);
  return {
    results,
    undo: () => {
      let n = 0;
      for (const r of restores.reverse()) {
        try {
          r();
          n++;
        } catch {
          // the page removed the field; nothing to restore
        }
      }
      restores.length = 0;
      return n;
    },
  };
}
