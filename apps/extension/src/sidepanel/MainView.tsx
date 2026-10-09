import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FILL_REASON_TEXT } from "@ufa/form-engine/fill";
import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import { CATEGORY_LABELS, PROFILE_CATEGORIES, PROFILE_FIELDS } from "@ufa/shared/catalog";
import type { ContentToPanel } from "../messages";
import { ApiError, assistantAnswer, assistantDraft, assistantMessage, setAiProfileSharing, confirmApplication, getCafe, mapForm, redeemCafeCode, saveForm, sendFillEvent, sendMappingFeedback, updateApplication, type CafeSessionOption, type FieldMappingView, type MapResult, type Me } from "./api";
import { choiceFor, FillControl, plannedItems, PreviewView, ResultView, toConfirmItem, type Choice, type FillOutcome, type Selection } from "./Fill";
import { analyzeTab, fillTab, getActiveTab, hasSitePermission, highlightField, isSupportedUrl, listUploadsInTab, requestAllSitesPermission, requestSitePermission, undoFillTab, type ActiveTab } from "./page";
import type { UploadField } from "@ufa/form-engine/dom";
import { autoAttach, UploadsCard } from "./Uploads";
import { AssistantChat, type ChatMsg } from "./AssistantChat";
import { isFillCommand, matchOption, planFill, roleOf, URL_IN_TEXT } from "./agent";

const KIND_LABEL: Record<string, string> = {
  text: "Text", textarea: "Text area", email: "Email", tel: "Phone", number: "Number", date: "Date", select: "Dropdown",
  radio: "Choice", checkbox: "Checkbox", file: "Upload", password: "Password", combobox: "Searchable list", contenteditable: "Editor",
};

const DECISION: Record<string, { label: string; cls: string }> = {
  AUTO_FILL: { label: "Ready", cls: "ok" },
  USER_REVIEW: { label: "Review", cls: "review" },
  ASK_USER: { label: "Needs you", cls: "ask" },
  GEMINI: { label: "Needs you", cls: "ask" },
  MANUAL: { label: "Manual", cls: "manual" },
};

const REASON: Record<string, string> = {
  confident: "Matched with high confidence",
  ai_suggestion: "Suggested by Gemini, please confirm",
  needs_review: "Probably right, please check",
  ambiguous: "Label can mean more than one thing",
  value_unverified: "Your saved value is not verified yet",
  sensitive: "Sensitive value, always confirmed by you",
  option_mismatch: "Your value is not one of the choices",
  missing_value: "Not in your profile yet",
  not_shared: "Not shared by the customer in this café session",
  unknown_field: "Not sure what this field is",
  ai_limit: "Not sure what this field is (daily AI limit reached)",
  not_profile_field: "Not a profile field",
  captcha: "CAPTCHA, type it yourself",
  otp: "OTP, enter it yourself",
  password: "Password, never filled",
  upload: "Upload — use “Upload fields on this page” above",
  declaration: "Declaration, tick it yourself after reading",
};

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type FeedbackFn = (f: NormalizedField, suggested: string | null, correct: string) => Promise<void>;

export function Main({ user, server, onSignedOut }: { user: Me; server: string; onSignedOut: () => void }) {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [snapshot, setSnapshot] = useState<FormSnapshot | null>(null);
  const [mapping, setMapping] = useState<MapResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(false);
  // Chrome shared nothing about this tab (panel opened on another tab): offer access instead of a dead end.
  const [needsAccess, setNeedsAccess] = useState(false);
  const [uploads, setUploads] = useState<UploadField[]>([]);
  const [selection, setSelection] = useState<Selection>({});
  const [phase, setPhase] = useState<"form" | "preview" | "result">("form");
  const [outcome, setOutcome] = useState<FillOutcome | null>(null);
  const [filling, setFilling] = useState(false);
  // Café mode: which customer the operator is filling for (null = own profile).
  const isCafeAccount = user.role === "CAFE_OWNER" || user.role === "CAFE_OPERATOR";
  const [cafe, setCafe] = useState<{ name: string; sessions: CafeSessionOption[] } | null>(null);
  const [cafeSessionId, setCafeSessionId] = useState<string | null>(null);

  const loadCafe = useCallback(async () => {
    if (!isCafeAccount) return;
    try {
      const r = await getCafe();
      setCafe(r.cafe ? { name: r.cafe.name, sessions: r.sessions } : null);
      setCafeSessionId((cur) => (cur && r.sessions.some((s) => s.id === cur) ? cur : null));
    } catch {
      setCafe(null);
    }
  }, [isCafeAccount]);

  useEffect(() => {
    void loadCafe();
  }, [loadCafe]);

  /** The customer revoked or the time ran out: leave café mode at once. */
  const handleCafeEnded = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.code === "cafe_session_ended") {
        setCafeSessionId(null);
        setMapping(null);
        setPhase("form");
        setError(err.message);
        void loadCafe();
        return true;
      }
      return false;
    },
    [loadCafe],
  );

  const loadTab = useCallback(async () => {
    const t = await getActiveTab();
    setTab(t);
    setAllowed(t?.url ? await hasSitePermission(t.url) : false);
    setSnapshot(null);
    setMapping(null);
    setError(null);
    setStatus(null);
    setSelection({});
    setPhase("form");
    setOutcome(null);
  }, []);

  useEffect(() => {
    void loadTab();
    const onActivated = () => void loadTab();
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
      if (t.active && info.status === "complete") void loadTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [loadTab]);

  const runMapping = useCallback(
    async (snap: FormSnapshot) => {
      if (snap.fields.length === 0) return setMapping(null);
      try {
        setMapping(await mapForm(snap, cafeSessionId));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else if (!handleCafeEnded(err)) setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onSignedOut, cafeSessionId, handleCafeEnded],
  );

  // Live updates from the content script (dynamic fields, SPA navigation).
  useEffect(() => {
    const listener = (msg: ContentToPanel, sender: chrome.runtime.MessageSender) => {
      if (msg?.type !== "UFA_FORM_CHANGED" || sender.tab?.id !== tab?.id) return;
      setSnapshot((prev) => {
        const before = prev ? prev.fields.filter((f) => f.visible).length : 0;
        const after = msg.snapshot.fields.filter((f) => f.visible).length;
        setStatus(msg.reason === "navigation" ? "Page changed, form re-read." : after > before ? `${after - before} new field(s) appeared.` : "Form updated.");
        return msg.snapshot;
      });
      void runMapping(msg.snapshot);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tab?.id, runMapping]);

  async function analyze() {
    if (!tab) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      let res;
      try {
        res = await analyzeTab(tab.id);
      } catch {
        // No access yet: ask for this one site (the click is the user gesture Chrome requires).
        if (tab.url && isSupportedUrl(tab.url) && (await requestSitePermission(tab.url))) {
          setAllowed(true);
          res = await analyzeTab(tab.id);
        } else if (!tab.url) {
          setNeedsAccess(true);
          return;
        } else {
          throw new Error("To read this page, click the extension icon while on the page, or allow this site.");
        }
      }
      if (!res.ok) throw new Error(res.error);
      setNeedsAccess(false);
      setSnapshot(res.snapshot);
      const up = await listUploadsInTab(tab.id);
      setUploads(up.ok ? up.fields : []);
      await runMapping(res.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function allowSite() {
    if (tab?.url && (await requestSitePermission(tab.url))) setAllowed(true);
  }

  // --- Assistant (agent) ------------------------------------------------------------------
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
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
    log(`Opening ${safeHost(url)}…`);
    await chrome.tabs.update(t.id, { url });
    await new Promise<void>((resolve) => {
      const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (id === t.id && info.status === "complete") done();
      };
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 30_000);
    });
    // Let single-page apps render their form.
    await new Promise((r) => setTimeout(r, 1500));
  }

  async function fillEverything() {
    if (agentRunning || cafeSessionId) return;
    stopped.current = false;
    setAgentRunning(true);
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
      setAgentRunning(false);
    }
  }

  async function onChatSend(text: string) {
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

  function stopAgent() {
    stopped.current = true;
    answerPending(null);
  }

  async function allowAllSites() {
    if (!(await requestAllSitesPermission())) return;
    setNeedsAccess(false);
    setAllowed(true);
    await loadTab();
    await analyze();
  }

  const feedback: FeedbackFn = async (field, suggestedKey, correctKey) => {
    if (!snapshot) return;
    try {
      const provider = mapping?.fields.find((x) => x.fieldId === field.id)?.sources.includes("gemini") ? "gemini" : null;
      await sendMappingFeedback({ domain: snapshot.domain, field: { signature: field.signature, label: field.label, language: field.language, section: field.section, kind: field.kind, options: field.options.slice(0, 50) }, suggestedKey, correctKey, provider });
      setStatus(correctKey === suggestedKey ? "Thanks, remembered for next time." : "Correction saved. Next time this field will be matched correctly.");
      await runMapping(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const planned = snapshot ? plannedItems(snapshot, mapping, selection) : [];

  /** Explicit confirmation: store the snapshot on the server, get the values, fill, report statuses. */
  async function confirmAndFill() {
    if (!snapshot || !tab || !mapping) return;
    setFilling(true);
    setError(null);
    setStatus(null);
    try {
      const items = plannedItems(snapshot, mapping, selection);
      const res = await confirmApplication({
        url: snapshot.url,
        domain: snapshot.domain,
        formTitle: snapshot.formTitle,
        pageTitle: snapshot.pageTitle,
        formSignatureId: mapping.formSignatureId,
        items: items.map(toConfirmItem),
        cafeSessionId,
      });
      const byField = new Map(items.map((i) => [i.field.id, i]));
      const fillItems = res.instructions
        .filter((ins) => byField.has(ins.fieldId))
        .map((ins) => ({ field: byField.get(ins.fieldId)!.field, instruction: { ...ins, overwrite: byField.get(ins.fieldId)!.choice.overwrite } }));
      const filled = await fillTab(tab.id, fillItems);
      if (!filled.ok) throw new Error(filled.error);
      await sendFillEvent(res.applicationId, { type: "FILLED", results: filled.results }).catch(() => {});
      setOutcome({ applicationId: res.applicationId, results: filled.results, undone: false, status: "CONFIRMED", customerName: mapping.cafe?.customerName ?? null });
      setPhase("result");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else if (!handleCafeEnded(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  async function undo() {
    if (!tab || !outcome) return;
    setFilling(true);
    const r = await undoFillTab(tab.id);
    if (r.ok) {
      await sendFillEvent(outcome.applicationId, { type: "UNDONE", restored: r.restored }).catch(() => {});
      await updateApplication(outcome.applicationId, { status: "CANCELLED" }).catch(() => {});
      setOutcome({ ...outcome, undone: true, status: "CANCELLED" });
      setStatus(`Undone: ${r.restored} field${r.restored === 1 ? "" : "s"} restored.`);
    } else setError(r.error);
    setFilling(false);
  }

  async function markSubmitted(applicationNumber: string) {
    if (!outcome) return;
    setFilling(true);
    try {
      await updateApplication(outcome.applicationId, { status: "SUBMITTED", applicationNumber: applicationNumber.trim() || null });
      setOutcome({ ...outcome, status: "SUBMITTED" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  const supported = isSupportedUrl(tab?.url ?? null);
  const host = tab?.url ? safeHost(tab.url) : null;

  return (
    <div className="pad stack">
      <div className="muted small">
        Hi {user.fullName.split(" ")[0]}
        {!user.emailVerified && " · please verify your email in the dashboard"}
      </div>

      <div className="card">
        <div className="row-between">
          <div className="ellipsis">
            <div className="small muted">Current page</div>
            <div className="ellipsis">{host ?? tab?.title ?? "—"}</div>
          </div>
          <button className="primary" onClick={analyze} disabled={busy || !tab || (tab.url !== null && !supported)}>
            {busy ? "Reading…" : snapshot ? "Analyze again" : "Analyze form"}
          </button>
        </div>
        {tab?.url && !supported && <p className="small muted">This kind of page cannot be read (browser or store pages).</p>}
        {supported && !allowed && (
          <button className="link small" onClick={allowSite}>
            Always allow on {host} (re-reads the form automatically when it changes)
          </button>
        )}
      </div>

      {isCafeAccount && cafe && (
        <CafeBar
          cafe={cafe}
          selected={cafeSessionId}
          busy={busy || filling}
          onSelect={(id) => {
            setCafeSessionId(id);
            setSelection({});
            setPhase("form");
            setOutcome(null);
            setStatus(id ? "Café mode: values come from the customer's profile." : null);
            if (snapshot) void (async () => {
              try {
                setMapping(await mapForm(snapshot, id));
              } catch (err) {
                if (!handleCafeEnded(err)) setError(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
          onRedeemed={async (id) => {
            await loadCafe();
            setCafeSessionId(id);
            setSelection({});
            setStatus("Session started. Analyze the form to fill it for this customer.");
          }}
        />
      )}
      {needsAccess && (
        <div className="warn">
          <b>Chrome has not given the assistant access to this tab yet.</b>
          <p className="small" style={{ margin: "6px 0" }}>
            Either click the extension icon in the toolbar while you are on this page, or allow it once for all websites. It still reads a page
            only when you press Analyze, and never submits anything.
          </p>
          <button className="primary" onClick={() => void allowAllSites()}>
            Allow on all websites
          </button>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {status && <div className="info">{status}</div>}
      {snapshot && tab && uploads.length > 0 && phase === "form" && !cafeSessionId && (
        <UploadsCard tabId={tab.id} domain={snapshot.domain} fields={uploads} server={server} />
      )}
      {snapshot && tab && phase === "preview" && (
        <PreviewView snapshot={snapshot} mapping={mapping} items={planned} busy={filling} onBack={() => setPhase("form")} onConfirm={confirmAndFill} />
      )}
      {snapshot && tab && phase === "result" && outcome && (
        <ResultView
          outcome={outcome}
          labels={new Map(snapshot.fields.map((f) => [f.id, f.label]))}
          busy={filling}
          onHighlight={(id) => highlightField(tab.id, id)}
          onUndo={undo}
          onSubmitted={markSubmitted}
          onDone={() => {
            setStatus(null);
            setPhase("form");
            setOutcome(null);
            setSelection({});
          }}
        />
      )}
      {snapshot && tab && phase === "form" && (
        <>
          <FormSummary
            snapshot={snapshot}
            mapping={mapping}
            tabId={tab.id}
            server={server}
            onFeedback={feedback}
            selection={selection}
            onChoice={(id, c) => setSelection((prev) => ({ ...prev, [id]: c }))}
          />
          {mapping && (
            <div className="fill-bar">
              <span className="small muted">{planned.length} selected · nothing is typed until you confirm</span>
              <button className="primary" disabled={planned.length === 0} onClick={() => setPhase("preview")}>
                Review &amp; fill {planned.length}
              </button>
            </div>
          )}
        </>
      )}

      {!cafeSessionId && (
        <AssistantChat
          messages={chat}
          running={agentRunning}
          waiting={waiting}
          onSend={(t) => void onChatSend(t)}
          onAction={(id) => answerPending(id)}
          onStop={stopAgent}
          onFillAll={() => void fillEverything()}
        />
      )}

      <p className="muted small">
        The assistant fills only what you confirm and never submits forms.{" "}
        <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/profile` })}>
          Open my profile
        </button>
      </p>
    </div>
  );
}

function FormSummary({
  snapshot,
  mapping,
  tabId,
  server,
  onFeedback,
  selection,
  onChoice,
}: {
  snapshot: FormSnapshot;
  mapping: MapResult | null;
  tabId: number;
  server: string;
  onFeedback: FeedbackFn;
  selection: Selection;
  onChoice: (fieldId: string, c: Choice) => void;
}) {
  const byId = useMemo(() => new Map((mapping?.fields ?? []).map((m) => [m.fieldId, m])), [mapping]);
  const groups = useMemo(() => {
    const m = new Map<string, NormalizedField[]>();
    for (const f of snapshot.fields) {
      const k = f.section ?? "Other fields";
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return [...m.entries()];
  }, [snapshot]);
  const visible = snapshot.fields.filter((f) => f.visible);
  const manual = visible.filter((f) => f.manual);
  const missing = [...new Set((mapping?.fields ?? []).filter((m) => m.reason === "missing_value" && m.profileFieldLabel).map((m) => m.profileFieldLabel!))];
  const crossOrigin = snapshot.warnings.find((w) => w.code === "cross_origin_iframes") as { count: number } | undefined;

  if (snapshot.fields.length === 0) {
    return (
      <div className="card">
        <b>No form fields found on this page.</b>
        <p className="small muted">
          {snapshot.warnings.some((w) => w.code === "closed_or_canvas_content")
            ? "This page may draw its form in a way extensions cannot read. You can still fill it manually."
            : "Open the page that contains the form, or wait for it to load, then analyze again."}
        </p>
      </div>
    );
  }

  const s = mapping?.stats;
  return (
    <>
      <div className="card">
        <div className="eyebrow">Form detected</div>
        <div className="title">{snapshot.formTitle ?? snapshot.pageTitle}</div>
        <div className="stats">
          <Stat n={s?.fields ?? visible.length} label="fields" />
          <Stat n={s?.matched ?? "…"} label="profile match" />
          <Stat n={s?.missingValues ?? "…"} label="missing" />
          <Stat n={s?.averageConfidence != null ? `${Math.round(s.averageConfidence * 100)}%` : "—"} label="confidence" />
        </div>
        {s && mapping && <DecisionBar s={s} localAi={mapping.engine.localAi} />}
        {mapping && <GeminiNote engine={mapping.engine} />}
        {mapping && !mapping.cafe && <History mapping={mapping} snapshot={snapshot} server={server} />}
      </div>

      {manual.length > 0 && (
        <div className="warn">
          <b>Manual action required</b> for {[...new Set(manual.map((m) => (m.manual === "captcha" ? "CAPTCHA" : m.manual === "otp" ? "OTP" : m.manual === "password" ? "password" : "a custom control")))].join(", ")}. These are never filled automatically.
        </div>
      )}
      {missing.length > 0 && mapping?.cafe && (
        <div className="info">
          <b>Not in the customer's profile:</b> {missing.join(", ")}. Ask the customer, type the answers in the panel, or they can add them to
          their profile later.
        </div>
      )}
      {missing.length > 0 && !mapping?.cafe && (
        <div className="info">
          <b>Missing in your profile:</b> {missing.join(", ")}.{" "}
          <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/profile` })}>
            Add them
          </button>{" "}
          and they will be remembered for every form.
        </div>
      )}
      {mapping?.formChange && (
        <div className="warn">
          <b>This form changed</b> since you applied on {new Date(mapping.formChange.lastAppliedAt).toLocaleDateString()}
          {mapping.formChange.added ? ` · ${mapping.formChange.added} new field${mapping.formChange.added === 1 ? "" : "s"}` : ""}
          {mapping.formChange.removed ? ` · ${mapping.formChange.removed} field${mapping.formChange.removed === 1 ? "" : "s"} removed` : ""}. Earlier
          matches for this site are double-checked, so more fields may ask for your review.
        </div>
      )}
      {crossOrigin && <div className="warn">Part of this page ({crossOrigin.count} embedded frame{crossOrigin.count > 1 ? "s" : ""}) comes from another site and cannot be read.</div>}

      {groups.map(([section, fields]) => (
        <div key={section} className="card">
          <div className="section">{section}</div>
          <ul className="fields">
            {fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                m={byId.get(f.id)}
                tabId={tabId}
                onFeedback={onFeedback}
                choice={choiceFor(selection, f, byId.get(f.id))}
                onChoice={(c) => onChoice(f.id, c)}
                showFill={Boolean(mapping)}
              />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function FieldRow({
  field: f,
  m,
  tabId,
  onFeedback,
  choice,
  onChoice,
  showFill,
}: {
  field: NormalizedField;
  m?: FieldMappingView;
  tabId: number;
  onFeedback: FeedbackFn;
  choice: Choice;
  onChoice: (c: Choice) => void;
  showFill: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const d = m ? DECISION[m.decision] : null;
  const canFeedback = Boolean(m && m.decision !== "MANUAL");
  return (
    <li className={f.visible ? "" : "hidden-field"}>
      <button className="field" onClick={() => highlightField(tabId, f.id)} title="Show on page">
        <span className="label">
          {f.label}
          {f.required && <span className="req"> *</span>}
          {d && <span className={`tag ${d.cls}`}>{d.label}</span>}
        </span>
        {m?.profileFieldKey ? (
          <span className="match">
            → {m.profileFieldLabel}
            {m.value !== null && (
              <>
                : <b>{m.optionMatch ?? m.value}</b>
              </>
            )}{" "}
            <span className="muted">({Math.round(m.confidence * 100)}%)</span>
          </span>
        ) : (
          m && m.decision !== "MANUAL" && m.candidates[0] && <span className="match muted">Maybe: {m.candidates[0].label}?</span>
        )}
        <span className="meta">
          {KIND_LABEL[f.kind] ?? f.kind}
          {f.options.length > 0 && ` · ${f.options.length} options`}
          {m && ` · ${(m.decision === "GEMINI" ? REASON.ai_limit : REASON[m.reason]) ?? m.reason}`}
          {m && !m.sources.includes("kb_user") && (m.sources.includes("kb_website") || m.sources.includes("kb_global")) && (
            <span className="tag" title="Confirmed by several other users of this assistant (no personal data is shared)">
              learned from others
            </span>
          )}
          {!f.visible && <span className="tag">not shown yet</span>}
        </span>
      </button>
      {showFill && <FillControl field={f} m={m} choice={choice} onChange={onChoice} />}
      {canFeedback && !changing && (
        <div className="fb">
          {m!.profileFieldKey && (
            <button className="link small" onClick={() => onFeedback(f, m!.profileFieldKey, m!.profileFieldKey!)} title="This match is correct">
              ✓ Correct
            </button>
          )}
          <button className="link small" onClick={() => setChanging(true)}>
            {m!.profileFieldKey ? "✗ Change" : "Choose field"}
          </button>
        </div>
      )}
      {changing && (
        <div className="fb">
          <select
            autoFocus
            defaultValue=""
            aria-label={`Profile field for ${f.label}`}
            onChange={async (e) => {
              if (!e.target.value) return;
              setChanging(false);
              await onFeedback(f, m?.profileFieldKey ?? null, e.target.value);
            }}
          >
            <option value="">Which profile field is this?</option>
            <option value="__none__">Not a profile field</option>
            {PROFILE_CATEGORIES.filter((c) => c !== "custom").map((c) => (
              <optgroup key={c} label={CATEGORY_LABELS[c].en}>
                {PROFILE_FIELDS.filter((p) => p.category === c).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label.en}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="link small" onClick={() => setChanging(false)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function GeminiNote({ engine }: { engine: MapResult["engine"] }) {
  const plural = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  const unsure = engine.geminiAsked - engine.geminiFields;
  const text: Record<string, string | null> = {
    used:
      `Gemini was asked about ${plural(engine.geminiAsked)} (only labels were sent)` +
      (engine.geminiFields ? `: ${engine.geminiFields} suggestion${engine.geminiFields === 1 ? "" : "s"} to check` : "") +
      (unsure > 0 ? `${engine.geminiFields ? ", " : ": "}not sure about ${unsure}, so ${unsure === 1 ? "it needs" : "they need"} you.` : "."),
    cached: engine.geminiFields
      ? `${plural(engine.geminiFields)} recognised from earlier Gemini answers.`
      : `Earlier Gemini answers: not sure about ${plural(engine.geminiAsked)}, so they need you.`,
    limit_reached: "Daily Gemini limit reached: remaining unknown fields need you.",
    failed: "Gemini is unavailable right now: unknown fields need you.",
    off: engine.cloudAiAllowed ? null : "Cloud AI is turned off in your settings.",
    not_needed: null,
  };
  const t = text[engine.gemini];
  return t ? <div className="small muted">{t}</div> : null;
}

/** Earlier applications on this form + Save this form. */
function History({ mapping, snapshot, server }: { mapping: MapResult; snapshot: FormSnapshot; server: string }) {
  const [saved, setSaved] = useState(mapping.savedForm !== null);
  const [error, setError] = useState<string | null>(null);
  const last = mapping.previousApplications[0];
  const openDashboard = (path: string) => chrome.tabs.create({ url: `${server}${path}` });

  return (
    <div className="history">
      {last ? (
        <div className="small">
          <b>You applied here before</b> on {new Date(last.createdAt).toLocaleDateString()}
          {last.status === "SUBMITTED" ? " (submitted" : " (filled, not marked submitted"}
          {last.applicationNumber ? `, no. ${last.applicationNumber})` : ")"}.{" "}
          <button className="link small" onClick={() => openDashboard(`/dashboard/applications/${last.id}`)}>
            View
          </button>
        </div>
      ) : (
        <div className="small muted">{mapping.seenBefore ? `Form seen before (first: ${new Date(mapping.firstSeenAt).toLocaleDateString()}).` : "First time this form is seen."}</div>
      )}
      {snapshot.url &&
        (saved ? (
          <span className="tag ok">★ Saved form</span>
        ) : (
          <button
            className="link small"
            onClick={async () => {
              setError(null);
              try {
                await saveForm({ name: snapshot.formTitle ?? snapshot.pageTitle ?? snapshot.domain, url: snapshot.url, formSignatureId: mapping.formSignatureId });
                setSaved(true);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            ☆ Save this form
          </button>
        ))}
      {error && <div className="small" style={{ color: "var(--err)" }}>{error}</div>}
    </div>
  );
}

function CafeBar({
  cafe,
  selected,
  busy,
  onSelect,
  onRedeemed,
}: {
  cafe: { name: string; sessions: CafeSessionOption[] };
  selected: string | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onRedeemed: (id: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const current = cafe.sessions.find((s) => s.id === selected);
  const minsLeft = current ? Math.max(0, Math.round((new Date(current.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <div className={`card cafe${current ? " on" : ""}`}>
      <div className="row-between">
        <div className="eyebrow">{cafe.name} · café mode</div>
        {current && <span className="tag review">{minsLeft} min left</span>}
      </div>
      <label className="small">
        Filling for
        <select className="answer" value={selected ?? ""} disabled={busy} onChange={(e) => onSelect(e.target.value || null)}>
          <option value="">Myself (my own profile)</option>
          {cafe.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.customerName}
              {s.purpose ? ` — ${s.purpose}` : ""}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <div className="small muted">
          Shared by the customer: {current.permissions.join(", ").replace(/_/g, " ")}. Everything you do is shown to them.
        </div>
      )}
      <form
        className="redeem"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setRedeeming(true);
          try {
            const r = await redeemCafeCode(code);
            setCode("");
            await onRedeemed(r.sessionId);
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setRedeeming(false);
          }
        }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Customer code XXXX-XXXX" aria-label="Customer code" maxLength={12} autoComplete="off" />
        <button className="secondary" disabled={redeeming || code.replace(/[\s-]/g, "").length < 8}>
          Start
        </button>
      </form>
      {err && <div className="small" style={{ color: "var(--err)" }}>{err}</div>}
    </div>
  );
}

function DecisionBar({ s, localAi }: { s: MapResult["stats"]; localAi: boolean }) {
  const parts = [
    { n: s.autoFill, cls: "ok", label: "ready", color: "#22c55e" },
    { n: s.review, cls: "review", label: "to review", color: "#f59e0b" },
    { n: s.askUser, cls: "ask", label: "need you", color: "#6366f1" },
    { n: s.manual, cls: "manual", label: "manual", color: "#ef4444" },
  ];
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <>
      <div className="bar" role="img" aria-label={parts.map((p) => `${p.n} ${p.label}`).join(", ")}>
        {parts.map((p) => (p.n ? <span key={p.cls} className={p.cls} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.cls}>
            <i style={{ background: p.color }} />
            {p.n} {p.label}
          </span>
        ))}
        {localAi && <span>· local AI used</span>}
      </div>
    </>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div className="stat">
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}
