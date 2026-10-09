/**
 * Makes the filler's real actions visible: a cursor glides to the element that is
 * about to be changed, shows a click, and text appears letter by letter. It only
 * shows what the filler actually does (no fake activity); it is a page overlay,
 * not the operating-system mouse, and it never receives clicks itself.
 */

const CURSOR_ID = "__ufa_cursor";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** No animation when the user asked for less motion, or when the tab is in the background (browsers slow its timers to a crawl). */
const reducedMotion = (doc: Document) => doc.hidden || (doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

function cursor(doc: Document): HTMLElement {
  let el = doc.getElementById(CURSOR_ID);
  if (el) return el;
  el = doc.createElement("div");
  el.id = CURSOR_ID;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.2,.7,.2,1),opacity .3s;opacity:0;";
  // Arrow cursor with a coloured edge so it stands out from the page's own pointer.
  el.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.8L4 20z" fill="#111827" stroke="#7c9cff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const vw = doc.defaultView?.innerWidth ?? 800;
  el.style.transform = `translate(${vw - 60}px, 40px)`;
  (doc.body ?? doc.documentElement).appendChild(el);
  return el;
}

/** Scrolls the element into view and moves the visible cursor onto it, then shows a click ring. */
export async function pointAt(target: Element): Promise<void> {
  const doc = target.ownerDocument;
  const smooth = !reducedMotion(doc);
  target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  if (smooth) await sleep(280);
  const r = target.getBoundingClientRect();
  const c = cursor(doc);
  c.style.opacity = "1";
  c.style.transform = `translate(${Math.round(r.left + Math.min(24, r.width / 2))}px, ${Math.round(r.top + r.height / 2 - 4)}px)`;
  if (smooth) await sleep(460);
  const ring = doc.createElement("div");
  ring.setAttribute("aria-hidden", "true");
  ring.style.cssText = `position:fixed;left:${Math.round(r.left + Math.min(24, r.width / 2)) - 14}px;top:${Math.round(r.top + r.height / 2) - 18}px;width:28px;height:28px;border-radius:50%;border:2px solid #4f6bff;z-index:2147483646;pointer-events:none;transition:transform .35s ease-out,opacity .35s ease-out;`;
  (doc.body ?? doc.documentElement).appendChild(ring);
  requestAnimationFrame(() => {
    ring.style.transform = "scale(1.8)";
    ring.style.opacity = "0";
  });
  setTimeout(() => ring.remove(), 450);
  if (smooth) await sleep(120);
}

/** Hides the cursor when the run is over. */
export function hideCursor(doc: Document): void {
  const c = doc.getElementById(CURSOR_ID);
  if (!c) return;
  c.style.opacity = "0";
  setTimeout(() => c.remove(), 350);
}

/**
 * Types `value` progressively through `write` (which sets the value the framework-safe
 * way). Total time is capped so long answers do not take ages.
 */
export async function typeProgressively(doc: Document, value: string, write: (partial: string) => void): Promise<void> {
  if (reducedMotion(doc) || value.length <= 1) return write(value);
  const steps = Math.min(value.length, 40);
  const delay = Math.max(8, Math.min(35, 1100 / steps));
  for (let i = 1; i <= steps; i++) {
    // The user switched tabs mid-way: finish at once instead of crawling.
    if (doc.hidden) return write(value);
    write(value.slice(0, Math.ceil((value.length * i) / steps)));
    await sleep(delay);
  }
}
