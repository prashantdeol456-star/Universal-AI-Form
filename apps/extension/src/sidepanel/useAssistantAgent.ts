import { useRef, useState } from "react";
import type { FormSnapshot } from "@ufa/form-engine";
import type { UploadField } from "@ufa/form-engine/dom";
import { FILL_REASON_TEXT } from "@ufa/form-engine/fill";
import { isFillCommand, matchOption, planFill, roleOf, URL_IN_TEXT } from "./agent";
import { ApiError, assistantAnswer, assistantDraft, assistantMessage, confirmApplication, mapForm, sendFillEvent, setAiProfileSharing, type MapResult } from "./api";
import type { ChatMsg } from "./AssistantChat";
import { plannedItems, toConfirmItem, type FillOutcome, type Selection } from "./Fill";
import { analyzeTab, fillTab, getActiveTab, listUploadsInTab, openUrlInTab, type ActiveTab } from "./page";
import { autoAttach } from "./Uploads";

/**
 * The assistant ("Fill everything" + chat) used by the Fill form view. It reads the page,
 * attaches documents, fills what the profile and saved answers know, asks for the rest in
 * chat and fills the page visibly. It never submits; Stop ends the run at the next step.
 * State lives in the side panel only (no persistent tasks yet).
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
  async function readPage() {
    const t = await getActiveTab();
    if (!t) return null;
    setTab(t);
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
    return { tabId: t.id, snap: res.snapshot, map, uploads: ups };
  }

  async function openUrl(url: string) {
    const t = await getActiveTab();
    if (!t) return;
    log(`Opening ${hostOf(url)}…`);
    await openUrlInTab(t.id, url);
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
        say("I can't read this tab yet. Use “Allow on all websites” above (or click the extension icon on the page), then press Fill everything again.", { tone: "warn" });
        return;
      }
      const { tabId, snap, map, uploads: ups } = page;
      log(`Found ${snap.fields.filter((f) => f.visible).length} fields${ups.length ? ` and ${ups.length} upload box(es)` : ""}.`);
      checkStop();

      const attached = await autoAttach(tabId, snap.domain, ups).catch((e: unknown) => [{ ok: false, text: e instanceof Error ? e.message : String(e) }]);
      for (const r of attached) log(r.text, r.ok ? "ok" : "warn");

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
      log(`Filling ${items.length} field(s) — watch the page…`);
      const res = await confirmApplication({
        url: snap.url,
        domain: snap.domain,
        formTitle: snap.formTitle,
        pageTitle: snap.pageTitle,
        formSignatureId: map?.formSignatureId ?? null,
        items: items.map(toConfirmItem),
        cafeSessionId: null,
      });
      const byField = new Map(items.map((i) => [i.field.id, i]));
      const fillItems = res.instructions
        .filter((ins) => byField.has(ins.fieldId))
        .map((ins) => ({ field: byField.get(ins.fieldId)!.field, instruction: { ...ins, overwrite: false } }));
      const filled = await fillTab(tabId, fillItems, true);
      if (!filled.ok) throw new Error(filled.error);
      await sendFillEvent(res.applicationId, { type: "FILLED", results: filled.results }).catch(() => {});
      // Written answers become saved answers once they are on the page.
      for (const d of drafted) await assistantAnswer({ question: d.question, answer: d.answer, kind: "textarea", domain: snap.domain }).catch(() => {});
      setOutcome({ applicationId: res.applicationId, results: filled.results, undone: false, status: "CONFIRMED", customerName: null });
      setPhase("result");

      const ok = filled.results.filter((r) => r.status === "filled").length;
      const failed = filled.results.filter((r) => r.status !== "filled");
      log(`Filled ${ok} of ${filled.results.length}.`, failed.length ? "warn" : "ok");
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
    if (url) {
      await openUrl(url);
      return void fillEverything();
    }
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
