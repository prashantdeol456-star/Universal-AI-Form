import { useCallback, useEffect, useRef, useState } from "react";
import type { FormSnapshot } from "@ufa/form-engine";
import type { ContentToPanel } from "../messages";
import { addTaskPage, ApiError, decideApproval, getTaskDetail, getCafe, mapForm, sendFillEvent, sendMappingFeedback, updateApplication, type CafeSessionOption, type MapResult, type Me } from "./api";
import { plannedItems, PreviewView, ResultView, type FillOutcome, type Selection } from "./Fill";
import { analyzeTab, getActiveTab, highlightField, isSupportedUrl, listUploadsInTab, undoFillTab, type ActiveTab } from "./page";
import type { UploadField } from "@ufa/form-engine/dom";
import { UploadsCard } from "./Uploads";
import { AssistantChat } from "./AssistantChat";
import { useAssistantAgent } from "./useAssistantAgent";
import { CafeBar } from "./CafeBar";
import { fillViaTask } from "./fillTask";
import { InspectionCard } from "./InspectionCard";
import { SiteAccessCard } from "./SiteAccessCard";
import { decide } from "./siteAccess";
import type { InspectionSummary } from "../messages";
import { FormSummary, type FeedbackFn } from "./FormSummary";

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function Main({ user, server, onSignedOut }: { user: Me; server: string; onSignedOut: () => void }) {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [snapshot, setSnapshot] = useState<FormSnapshot | null>(null);
  const [mapping, setMapping] = useState<MapResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Chrome shared nothing about this tab (panel opened on another tab).
  const [needsAccess, setNeedsAccess] = useState(false);
  const [inspection, setInspection] = useState<InspectionSummary | null>(null);
  // Multi-page forms: the fill task this page continues (the user moved here themselves).
  const [continueTaskId, setContinueTaskId] = useState<string | null>(null);
  // One idempotency key per reviewed preview: a double click never creates two fill tasks.
  const fillKey = useRef<string>(crypto.randomUUID());
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
    setSnapshot(null);
    setInspection(null);
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
      // Policy first: only a site the user allowed is read at all.
      const d = await decide("inspect", tab.url);
      if (!d.allowed) {
        if (!tab.url) setNeedsAccess(true);
        throw new Error(d.reason);
      }
      let res;
      try {
        res = await analyzeTab(tab.id);
      } catch {
        throw new Error(`Chrome has not given the assistant access to ${safeHost(tab.url!)} on this computer. Use “Remove access” and allow the site again, or click the extension icon on the page.`);
      }
      if (!res.ok) throw new Error(res.error);
      setNeedsAccess(false);
      setSnapshot(res.snapshot);
      setInspection(res.inspection);
      fillKey.current = crypto.randomUUID();
      const up = await listUploadsInTab(tab.id);
      setUploads(up.ok ? up.fields : []);
      await runMapping(res.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const agent = useAssistantAgent({
    cafeSessionId,
    onSignedOut,
    setTab,
    setSnapshot,
    setMapping,
    setUploads,
    setNeedsAccess,
    setSelection,
    setOutcome,
    setPhase,
    setError,
    setStatus,
  });

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
      const d = await decide("fill", tab.url);
      if (!d.allowed) throw new Error(d.reason);
      const items = plannedItems(snapshot, mapping, selection);
      const r = await fillViaTask({ tabId: tab.id, snapshot, mapping, items, taskId: continueTaskId, cafeSessionId, idempotencyKey: `fill-${fillKey.current}` });
      setContinueTaskId(null);
      setOutcome({
        applicationId: r.applicationId,
        results: r.results,
        undone: false,
        status: "CONFIRMED",
        customerName: mapping.cafe?.customerName ?? null,
        taskId: r.taskId,
        verification: r.verification,
        pageChanged: r.pageChanged,
      });
      setPhase("result");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else if (!handleCafeEnded(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  /** The user clicked the website's Next button themselves; the task continues on this (same-site) page. */
  async function continueOnNextPage(taskId: string) {
    if (!tab) return;
    setFilling(true);
    setError(null);
    try {
      const t = await getActiveTab();
      if (!t?.url) throw new Error("Chrome has not shared this tab. Click the extension icon on the page.");
      await addTaskPage(taskId, t.url);
      setContinueTaskId(taskId);
      setOutcome(null);
      setSelection({});
      setPhase("form");
      setSnapshot(null);
      setInspection(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  /** The user reviewed all pages and submits on the website themselves: close the task (nothing is submitted). */
  async function finishFillTask(taskId: string) {
    setFilling(true);
    setError(null);
    try {
      let approval = null;
      for (let i = 0; i < 20 && !approval; i++) {
        approval = (await getTaskDetail(taskId)).approvals.find((a) => a.status === "pending") ?? null;
        if (!approval) await new Promise((r) => setTimeout(r, 400));
      }
      if (!approval) throw new Error("The task is not ready to close yet. Check the Tasks tab.");
      await decideApproval(approval.id, "approve");
      setStatus("Task closed. Submit the form on the website yourself when you are ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        <SiteAccessCard key={tab?.url ?? "none"} url={tab?.url ?? null} onChange={(site) => site && setError(null)} />
      </div>
      {continueTaskId && <div className="info small">Continuing your fill task on this page: analyze it, check the preview, then fill.</div>}

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
        <div className="warn small">
          <b>Chrome has not shared this tab with the assistant.</b> Click the extension icon in the Chrome toolbar while you are on the page. The
          assistant asks for one site at a time, never for all websites.
        </div>
      )}
      {inspection && snapshot && phase === "form" && <InspectionCard inspection={inspection} fieldCount={snapshot.fields.length} />}
      {error && <div className="alert">{error}</div>}
      {status && <div className="info">{status}</div>}
      {snapshot && tab && uploads.length > 0 && phase === "form" && !cafeSessionId && (
        <UploadsCard tabId={tab.id} url={snapshot.url} domain={snapshot.domain} fields={uploads} server={server} />
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
          onNextPage={outcome.taskId ? () => void continueOnNextPage(outcome.taskId!) : undefined}
          onFinishTask={outcome.taskId ? () => void finishFillTask(outcome.taskId!) : undefined}
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
          messages={agent.chat}
          running={agent.running}
          waiting={agent.waiting}
          onSend={(t) => void agent.send(t)}
          onAction={(id) => agent.answer(id)}
          onStop={agent.stop}
          onFillAll={() => void agent.fillEverything()}
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
