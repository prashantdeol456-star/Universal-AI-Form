import { useRef, useState } from "react";
import { checkUrl, decideAction, type FormSnapshot } from "@ufa/form-engine";
import type { UploadField } from "@ufa/form-engine/dom";
import { FILL_REASON_TEXT } from "@ufa/form-engine/fill";
import { isFillCommand, matchOption, planFill, roleOf, URL_IN_TEXT } from "./agent";
import { ApiError, assistantAnswer, assistantDraft, assistantMessage, mapForm, setAiProfileSharing, type MapResult } from "./api";
import type { ChatMsg } from "./AssistantChat";
import { plannedItems, type FillOutcome, type Selection } from "./Fill";
import { fillViaTask } from "./fillTask";
import { analyzeTab, getActiveTab, listUploadsInTab, openUrlInTab, type ActiveTab } from "./page";
import { decide } from "./siteAccess";
import { attachDocument, attachSuggestions } from "./Uploads";

/**
 * The assistant ("Fill everything" + chat) used by the Fill form view. It reads the page
 * (only on sites the user allowed), asks before attaching each document, works out what the
 * profile and saved answers know, asks for the rest in chat, shows what it will fill and
 * waits for "Fill these", then fills through a fill task and re-reads every field. It never
 * submits or clicks Next; a pasted link is only opened after the user checks it. Stop ends
 * the run at the next step.
 */
export interface AgentDeps {
  /** Café mode: the assistant is off while an operator fills for a customer. */
  cafeSessionId: string | null;
  onSignedOut: () => void;
  setTab: (t: ActiveTab) => void;
  setSnapshot: (s: FormSnapshot) => void;
  setMapping: (m: MapResult | null) => void;
  setUploads: (u: UploadField[]) => void;
  setNeedsAccess: (v: boolean) => void;
  setSelection: (s: Selection) => void;
  setOutcome: (o: FillOutcome) => void;
  setPhase: (p: "form" | "preview" | "result") => void;
  setError: (e: string | null) => void;
  setStatus: (s: string | null) => void;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export function useAssistantAgent(deps: AgentDeps) {
  const { cafeSessionId, onSignedOut, setTab, setSnapshot, setMapping, setUploads, setNeedsAccess, setSelection, setOutcome, setPhase, setError, setStatus } = deps;
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<((reply: string | null) => void) | null>(null);
  const stopped = useRef(false);
  const msgId = useRef(1);

  const push = (m: Omit<ChatMsg, "id">) => setChat((c) => [...c, { ...m, id: msgId.current++ }]);
  const say = (text: string, extra: Partial<ChatMsg> = {}) => push({ role: "assistant", text, ...extra });
  const log = (text: string, tone?: ChatMsg["tone"]) => push({ role: "log", text, tone });

  /** Asks in chat and waits for the reply (null when stopped). */
  const askUser = (text: string, actions?: ChatMsg["actions"]) =>
    new Promise<string | null>((resolve) => {
      pending.current = resolve;
      setWaiting(true);
      say(text, { actions });
    });

  const answerPending = (reply: string | null) => {
    const r = pending.current;
    pending.current = null;
    setWaiting(false);
    r?.(reply);
  };

  const checkStop = () => {
    if (stopped.current) throw new Error("__stopped__");
  };

  /** Reads the active tab for the agent and returns the fresh results (state updates are async). */
  async function readPage(): Promise<{ denied: string } | { tabId: number; url: string | null; snap: FormSnapshot; map: MapResult | null; uploads: UploadField[] } | null> {
    const t = await getActiveTab();
    if (!t) return null;
    setTab(t);
    // Least privilege: only pages of sites the user allowed are read.
    const d = await decide("inspect", t.url);
    if (!d.allowed) return { denied: d.fix === "authorize_site" ? `${d.reason}. Allow it in “Site access” above, then press Fill everything again.` : d.reason };
    let res;
    try {
      res = await analyzeTab(t.id);
    } catch {
      setNeedsAccess(true);
      return null;
    }
    if (!res.ok) throw new Error(res.error);
    setNeedsAccess(false);
    setSnapshot(res.snapshot);
    const map = res.snapshot.fields.length ? await mapForm(res.snapshot, null) : null;
    setMapping(map);
    const up = await listUploadsInTab(t.id);
    const ups = up.ok ? up.fields : [];
    setUploads(ups);
    return { tabId: t.id, url: t.url, snap: res.snapshot, map, uploads: ups };
  }

  /** A pasted link: shown for review first, opened only on "Open", and nothing is filled automatically afterwards. */
  async function reviewAndOpen(url: string) {
    const c = checkUrl(url);
    if (!c.ok) return say(`I won't open that link: ${c.reason}.`, { tone: "warn" });
    const reply = await askUser(`Open this page in the current tab?\n${c.host}\n${url.length > 200 ? `${url.slice(0, 200)}…` : url}\nI will only open it. Nothing is filled until you press Fill everything.`, [
      { id: "__open__", label: `Open ${c.host}` },
      { id: "__cancel__", label: "Cancel" },
    ]);
    if (reply !== "__open__") return log("Not opened.");
    const d = decideAction({ action: "open_url", url, targetUrl: url, grants: [], reviewedByUser: true });
    if (!d.allowed) return say(d.reason, { tone: "warn" });
    const t = await getActiveTab();
    if (!t) return;
    log(`Opening ${hostOf(url)}…`);
    await openUrlInTab(t.id, url);
    say(`Opened ${c.host}. Check the page; if it has a form, allow the site under “Site access” and press Fill everything.`);
  }

  async function fillEverything() {
    if (running || cafeSessionId) return;
    stopped.current = false;
    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      log("Reading the page…");
      const page = await readPage();
      if (!page) {
        say("I can't read this tab yet. Click the extension icon on the page, then press Fill everything again.", { tone: "warn" });
        return;
      }
      if ("denied" in page) {
        say(page.denied, { tone: "warn" });
        return;
      }
      const { tabId, url, snap, map, uploads: ups } = page;
      log(`Found ${snap.fields.filter((f) => f.visible).length} fields${ups.length ? ` and ${ups.length} upload box(es)` : ""}.`);
      checkStop();

      // Documents: offered one at a time; only the exact file the user approves goes into that one field.
      const offers = await attachSuggestions(ups).catch(() => []);
      if (offers.length) {
        const canAttach = await decide("attach_file", url);
        for (const o of offers) {
          checkStop();
          if (!o.doc) {
            log(`“${o.field.label}” wants your ${o.what}; none of an accepted type is in your documents. Upload it in Dashboard → Documents, or choose a file on the page.`, "warn");
            continue;
          }
          if (!canAttach.allowed) {
            log(`“${o.field.label}” wants your ${o.what}: ${canAttach.reason}. Use “Upload fields on this page” below to allow and attach it.`, "warn");
            continue;
          }
          const reply = await askUser(`Attach your ${o.what} “${o.doc.fileName}” to “${o.field.label}”?`, [
            { id: "__attach__", label: "Attach" },
            { id: "__skip__", label: "Skip" },
          ]);
          checkStop();
          if (reply !== "__attach__") {
            log(`Did not attach anything to “${o.field.label}”.`);
            continue;
          }
          const res = await attachDocument(tabId, snap.domain, o.field.id, o.doc.id).catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }));
          log(res.text, res.ok ? "ok" : "warn");
        }
      }

      const plan = planFill(snap, map);
      const sel: Selection = { ...plan.selection };
      const fromProfile = Object.values(sel).filter((c) => !c.manualValue).length;
      const fromMemory = Object.values(sel).filter((c) => c.manualValue).length;
      log(`${fromProfile} from your profile${fromMemory ? `, ${fromMemory} from answers you gave before` : ""}.`);

      // Written answers ("Tell us about yourself").
      let consentAsked = false;
      const drafted: Array<{ question: string; answer: string }> = [];
      for (const f of plan.write) {
        checkStop();
        log(`Writing an answer for “${f.label}”…`);
        let d = await assistantDraft({ question: f.label, role: roleOf(snap) });
        if (d.canAskConsent && !consentAsked) {
          consentAsked = true;
          const r = await askUser(
            "I can write a much better answer with AI if I may send your professional profile (summary, skills, current job, education — never ID numbers or contact details) to Google Gemini. Allow?",
            [
              { id: "__allow__", label: "Allow" },
              { id: "__no__", label: "No, use my own words" },
            ],
          );
          checkStop();
          if (r === "__allow__") {
            await setAiProfileSharing(true);
            d = await assistantDraft({ question: f.label, role: roleOf(snap) });
          }
        }
        if (!d.answer.trim()) {
          log(`Skipped “${f.label}”: ${d.missing[0] ?? "nothing to write from yet"}`, "warn");
          continue;
        }
        sel[f.id] = { include: true, manualValue: d.answer, overwrite: false };
        drafted.push({ question: f.label, answer: d.answer });
        say(`“${f.label}” (${d.source === "gemini" ? "AI draft" : "from your profile"}):\n${d.answer}`);
        if (d.missing.length) say(`To make it stronger, tell me: ${d.missing.join(" ")}`);
      }

      // Facts I don't have: ask in chat, save for next time.
      for (const { field: f, mapping: m } of plan.ask) {
        checkStop();
        const opts = f.options.length ? ` Choices: ${f.options.slice(0, 12).join(" / ")}.` : "";
        let value: string | null = null;
        for (let attempt = 0; attempt < 2 && value === null; attempt++) {
          const reply = await askUser(`${attempt ? "I couldn't match that. " : ""}What should I enter for “${f.label}”?${opts} (type “skip” to leave it)`);
          checkStop();
          if (reply === null || /^skip$/i.test(reply.trim())) break;
          value = matchOption(f.options, reply);
        }
        if (value === null) {
          log(`Left “${f.label}” for you.`, "warn");
          continue;
        }
        sel[f.id] = { include: true, manualValue: value, overwrite: false };
        try {
          const saved = await assistantAnswer({ question: f.label, answer: value, profileFieldKey: m?.profileFieldKey ?? null, kind: f.kind, domain: snap.domain });
          log(saved.savedTo === "profile" ? `Saved to your profile: ${saved.label}.` : saved.savedTo === "answers" ? "Remembered this answer for next time." : "Used it for this form only.", "ok");
        } catch (e) {
          log(`Not saved (${e instanceof Error ? e.message : String(e)}), but I'll use it here.`, "warn");
        }
      }

      checkStop();
      setSelection(sel);
      const items = plannedItems(snap, map, sel);
      if (!items.length) {
        say("There is nothing on this page I can fill.");
        return;
      }
      const canFill = await decide("fill", url);
      if (!canFill.allowed) {
        say(canFill.fix === "authorize_site" ? `${canFill.reason}. Allow filling under “Site access” above, then press Fill everything again.` : canFill.reason, { tone: "warn" });
        return;
      }
      // The user sees every value before anything is typed (the full preview stays editable in the form view).
      const short = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v).replace(/\s+/g, " ");
      const lines = items.slice(0, 25).map((i) => `• ${i.field.label}: ${short(i.display)}`);
      const go = await askUser(`I will fill ${items.length} field(s) on ${hostOf(snap.url)}:\n${lines.join("\n")}${items.length > 25 ? `\n…and ${items.length - 25} more` : ""}\nNothing is submitted.`, [
        { id: "__fill__", label: "Fill these" },
        { id: "__cancel__", label: "Cancel" },
      ]);
      checkStop();
      if (go !== "__fill__") {
        setPhase("preview");
        say("Not filled. You can change values in the preview and fill from there.");
        return;
      }
      log(`Filling ${items.length} field(s) — watch the page…`);
      const done = await fillViaTask({ tabId, snapshot: snap, mapping: map, items, idempotencyKey: `agent-${globalThis.crypto.randomUUID()}` });
      // Written answers become saved answers once they are on the page.
      for (const d of drafted) await assistantAnswer({ question: d.question, answer: d.answer, kind: "textarea", domain: snap.domain }).catch(() => {});
      setOutcome({
        applicationId: done.applicationId,
        results: done.results,
        undone: false,
        status: "CONFIRMED",
        customerName: null,
        taskId: done.taskId,
        verification: done.verification,
        pageChanged: done.pageChanged,
      });
      setPhase("result");

      const ok = done.results.filter((r) => r.status === "filled").length;
      const failed = done.results.filter((r) => r.status !== "filled");
      const v = Object.values(done.verification);
      const checked = v.filter((x) => x === "verified").length;
      log(`Filled ${ok} of ${done.results.length}; ${checked} checked on the page.`, failed.length || checked < v.length ? "warn" : "ok");
      if (done.pageChanged) say("The page changed while filling, so the task was paused. Check the page before you continue.", { tone: "warn" });
      if (failed.length) {
        const labelOf = (id: string) => snap.fields.find((f) => f.id === id)?.label ?? id;
        say(`Not filled: ${failed.map((r) => `“${labelOf(r.fieldId)}” (${r.reason ? FILL_REASON_TEXT[r.reason] : r.status})`).join(", ")}.`, { tone: "warn" });
      }
      const yours = plan.yours.map((f) => `“${f.label}”`);
      say(`Done. Please check the page${yours.length ? `, then do these yourself: ${yours.join(", ")}` : ""}, and press Submit when you are happy. I never submit for you.`, { tone: "ok" });
    } catch (err) {
      if (err instanceof Error && err.message === "__stopped__") log("Stopped.", "warn");
      else {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        say(err instanceof Error ? err.message : String(err), { tone: "warn" });
      }
    } finally {
      pending.current = null;
      setWaiting(false);
      setRunning(false);
    }
  }

  async function send(text: string) {
    push({ role: "user", text });
    if (pending.current) return answerPending(text);
    const url = URL_IN_TEXT.exec(text)?.[0];
    if (url) return void reviewAndOpen(url);
    if (isFillCommand(text)) return void fillEverything();
    try {
      const r = await assistantMessage(text);
      if (r.saved.length) say(`Saved to your profile: ${r.saved.map((s) => `${s.label} = ${s.value}`).join(", ")}.`, { tone: "ok" });
      if (r.skipped.length) say(`Not saved here (sensitive or invalid): ${r.skipped.join(", ")}. Add these in your dashboard profile.`, { tone: "warn" });
      if (!r.saved.length && !r.skipped.length) say("Got it. Tell me facts like “my current city is Noida” to save them, paste a link to open, or type “fill” to fill this page.");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), { tone: "warn" });
    }
  }

  function stop() {
    stopped.current = true;
    answerPending(null);
  }

  return { chat, running, waiting, send, answer: answerPending, stop, fillEverything };
}
