import { isVisible } from "./detect";
import { setNativeValue } from "./fill";

/**
 * Puts an email draft the user approved into an open compose window (Gmail,
 * Outlook on the web, or the text box the user clicked). It only writes text:
 * it never presses Send, never submits and never attaches files. An existing
 * subject is kept; the draft goes above anything already in the body (a
 * signature or quoted reply stays below). `undo()` removes exactly what it added.
 */

export interface EmailInsertResult {
  target: "gmail" | "outlook" | "field" | null;
  body: "inserted" | "not_found";
  subject: "filled" | "kept" | "not_found";
}

export interface EmailInsertRun {
  result: EmailInsertResult;
  undo(): boolean;
}

type Editable = HTMLElement | HTMLTextAreaElement;

const isTextarea = (el: Element): el is HTMLTextAreaElement => el.tagName === "TEXTAREA";
const isEditable = (el: Element | null): el is HTMLElement =>
  Boolean(el && (el as HTMLElement).isContentEditable !== undefined && ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true"));
const label = (el: Element) => (el.getAttribute("aria-label") ?? "").toLowerCase();

function findBody(doc: Document): { el: Editable; target: EmailInsertResult["target"] } | null {
  const host = doc.location?.hostname ?? "";
  const editables = [...doc.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""], [role="textbox"][g_editable="true"]')].filter(isVisible);
  const pick = (list: HTMLElement[]) => list.find((el) => el.contains(doc.activeElement)) ?? list.at(-1) ?? null;

  const gmail = pick(editables.filter((e) => e.getAttribute("g_editable") === "true"));
  if (gmail) return { el: gmail, target: "gmail" };
  // Gmail and Outlook on the web both label the compose body "Message body".
  const labelled = pick(editables.filter((e) => /message (body|text)/.test(label(e))));
  if (labelled) return { el: labelled, target: /mail\.google\./.test(host) ? "gmail" : "outlook" };

  // The text box the user was typing in.
  const active = doc.activeElement;
  if (active && (isTextarea(active) || isEditable(active)) && isVisible(active)) return { el: active as Editable, target: "field" };
  const areas = [...doc.querySelectorAll("textarea")].filter((t) => isVisible(t) && !t.disabled && !t.readOnly);
  if (areas.length === 1) return { el: areas[0]!, target: "field" };
  return null;
}

/** Subject input that belongs to the same compose window as the body. */
function findSubject(body: Element): HTMLInputElement | null {
  const matches = (i: HTMLInputElement) =>
    isVisible(i) && !i.disabled && (i.name === "subjectbox" || i.name.toLowerCase().includes("subject") || label(i).includes("subject") || (i.placeholder ?? "").toLowerCase().includes("subject"));
  for (let cur: Element | null = body.parentElement, depth = 0; cur && depth < 20; cur = cur.parentElement, depth++) {
    const found = [...cur.querySelectorAll<HTMLInputElement>("input")].find(matches);
    if (found) return found;
  }
  return null;
}

function fire(target: Element, type: string) {
  const W = target.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (W) target.dispatchEvent(new W.Event(type, { bubbles: true, composed: true }));
}

export function insertEmailDraft(doc: Document, draft: { subject: string; body: string }): EmailInsertRun {
  const found = findBody(doc);
  if (!found) return { result: { target: null, body: "not_found", subject: "not_found" }, undo: () => false };
  const undoSteps: Array<() => void> = [];

  // Body
  const text = draft.body.replace(/\r\n/g, "\n");
  if (isTextarea(found.el)) {
    const area = found.el;
    const before = area.value;
    area.focus({ preventScroll: true });
    setNativeValue(area, before.trim() ? `${text}\n\n${before}` : text);
    fire(area, "input");
    fire(area, "change");
    undoSteps.push(() => {
      setNativeValue(area, before);
      fire(area, "input");
    });
  } else {
    const box = found.el;
    const docRef = box.ownerDocument;
    const nodes: Node[] = [];
    for (const line of text.split("\n")) {
      const div = docRef.createElement("div");
      if (line) div.textContent = line;
      else div.appendChild(docRef.createElement("br"));
      nodes.push(div);
    }
    if (box.textContent?.trim()) {
      const gap = docRef.createElement("div");
      gap.appendChild(docRef.createElement("br"));
      nodes.push(gap);
    }
    const first = box.firstChild;
    for (const n of nodes) box.insertBefore(n, first);
    box.focus({ preventScroll: true });
    fire(box, "input");
    undoSteps.push(() => {
      for (const n of nodes) n.parentNode?.removeChild(n);
      fire(box, "input");
    });
  }

  // Subject: filled only when empty, never overwritten (e.g. "Re: …" in a reply).
  let subject: EmailInsertResult["subject"] = "not_found";
  const input = findSubject(found.el);
  if (input) {
    if (input.value.trim()) subject = "kept";
    else if (draft.subject.trim()) {
      setNativeValue(input, draft.subject.trim());
      fire(input, "input");
      fire(input, "change");
      subject = "filled";
      undoSteps.push(() => {
        setNativeValue(input, "");
        fire(input, "input");
      });
    } else subject = "kept";
  }

  let undone = false;
  return {
    result: { target: found.target, body: "inserted", subject },
    undo() {
      if (undone) return false;
      undone = true;
      for (const step of undoSteps.reverse()) step();
      return true;
    },
  };
}
