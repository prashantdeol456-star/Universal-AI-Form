import { useCallback, useEffect, useState } from "react";
import type { FormSnapshot } from "@ufa/form-engine";
import type { ContentToPanel } from "../messages";
import { ApiError, confirmApplication, getCafe, mapForm, sendFillEvent, sendMappingFeedback, updateApplication, type CafeSessionOption, type MapResult, type Me } from "./api";
import { plannedItems, PreviewView, ResultView, toConfirmItem, type FillOutcome, type Selection } from "./Fill";
import { analyzeTab, fillTab, getActiveTab, hasSitePermission, highlightField, isSupportedUrl, listUploadsInTab, requestAllSitesPermission, requestSitePermission, undoFillTab, type ActiveTab } from "./page";
import type { UploadField } from "@ufa/form-engine/dom";
import { UploadsCard } from "./Uploads";
import { AssistantChat } from "./AssistantChat";
import { useAssistantAgent } from "./useAssistantAgent";
import { CafeBar } from "./CafeBar";
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
