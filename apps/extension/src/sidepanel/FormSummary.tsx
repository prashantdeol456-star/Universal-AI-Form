import { useMemo, useState } from "react";
import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import { CATEGORY_LABELS, PROFILE_CATEGORIES, PROFILE_FIELDS } from "@ufa/shared/catalog";
import { saveForm, type FieldMappingView, type MapResult } from "./api";
import { choiceFor, FillControl, type Choice, type Selection } from "./Fill";
import { highlightField } from "./page";

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

export type FeedbackFn = (f: NormalizedField, suggested: string | null, correct: string) => Promise<void>;

export function FormSummary({
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
