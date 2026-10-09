import { useState } from "react";
import type { FillResult, FormSnapshot, NormalizedField } from "@ufa/form-engine";
import { FILL_REASON_TEXT } from "@ufa/form-engine/fill";
import type { ConfirmItem, FieldMappingView, MapResult } from "./api";

/**
 * Form filling in the side panel (spec §31–33): choose → preview → explicit
 * confirmation → fill → result (undo / "I submitted it"). Nothing is typed into
 * the page before the user clicks "Confirm & fill", and the form is never submitted.
 */

export interface Choice {
  include: boolean;
  manualValue: string;
  overwrite: boolean;
}
export type Selection = Record<string, Choice>;

export const isFillable = (f: NormalizedField) => !f.manual && f.kind !== "file" && f.kind !== "password" && !f.disabled && !f.readOnly;

/** A profile value exists for this mapping (the server will read it). */
const hasProfileValue = (m?: FieldMappingView) => Boolean(m?.profileFieldKey && m.value !== null && m.decision !== "MANUAL");

/** Manual typing is offered for fields we could not fill from the profile (single checkboxes excluded). */
const canTypeManually = (f: NormalizedField, m?: FieldMappingView) =>
  isFillable(f) && !hasProfileValue(m) && !(f.kind === "checkbox" && f.options.length <= 1) && m?.decision !== "MANUAL";

export function choiceFor(sel: Selection, f: NormalizedField, m?: FieldMappingView): Choice {
  return (
    sel[f.id] ?? {
      // Pre-ticked only when the engine is confident, the value exists and the page field is empty.
      include: isFillable(f) && hasProfileValue(m) && m!.decision === "AUTO_FILL" && !f.hasValue,
      manualValue: "",
      overwrite: false,
    }
  );
}

export interface PlannedItem {
  field: NormalizedField;
  mapping?: FieldMappingView;
  choice: Choice;
  source: "profile" | "manual";
  display: string;
}

/** The items that will be filled, in page order. */
export function plannedItems(snapshot: FormSnapshot, mapping: MapResult | null, sel: Selection): PlannedItem[] {
  const byId = new Map((mapping?.fields ?? []).map((m) => [m.fieldId, m]));
  const out: PlannedItem[] = [];
  for (const f of snapshot.fields) {
    const m = byId.get(f.id);
    const c = choiceFor(sel, f, m);
    if (!c.include || !isFillable(f)) continue;
    if (hasProfileValue(m)) out.push({ field: f, mapping: m, choice: c, source: "profile", display: m!.optionMatch ?? m!.value! });
    else if (canTypeManually(f, m) && c.manualValue.trim()) out.push({ field: f, mapping: m, choice: c, source: "manual", display: c.manualValue.trim() });
  }
  return out;
}

export function toConfirmItem(p: PlannedItem): ConfirmItem {
  const sources = p.mapping?.sources ?? [];
  return {
    field: {
      id: p.field.id,
      signature: p.field.signature,
      label: p.field.label,
      name: p.field.name,
      kind: p.field.kind,
      options: p.field.options,
      manual: p.field.manual,
      section: p.field.section,
      language: p.field.language,
    },
    source: p.source,
    profileFieldKey: p.source === "profile" ? p.mapping!.profileFieldKey : null,
    manualValue: p.source === "manual" ? p.choice.manualValue.trim() : null,
    confidence: p.source === "profile" ? p.mapping!.confidence : null,
    aiProvider: p.source !== "profile" ? null : sources.includes("gemini") ? "gemini" : sources.includes("local_ai") ? "local_ai" : null,
  };
}

/** Per-field controls inside a field row: "Fill" tick, manual value, replace existing value. */
export function FillControl({ field: f, m, choice, onChange }: { field: NormalizedField; m?: FieldMappingView; choice: Choice; onChange: (c: Choice) => void }) {
  if (!isFillable(f)) return null;
  const fromProfile = hasProfileValue(m);
  const manual = canTypeManually(f, m);
  if (!fromProfile && !manual) return null;
  const review = fromProfile && m!.decision !== "AUTO_FILL";

  return (
    <div className="fill-ctl">
      {manual && (
        <ManualInput
          field={f}
          value={choice.manualValue}
          onChange={(v) => onChange({ ...choice, manualValue: v, include: v.trim() !== "" })}
        />
      )}
      {(fromProfile || choice.manualValue.trim()) && (
        <label className="check small">
          <input type="checkbox" checked={choice.include} onChange={(e) => onChange({ ...choice, include: e.target.checked })} />
          {review ? "Fill this (I checked the value)" : "Fill this"}
        </label>
      )}
      {choice.include && f.hasValue && (
        <label className="check small">
          <input type="checkbox" checked={choice.overwrite} onChange={(e) => onChange({ ...choice, overwrite: e.target.checked })} />
          Page already has a value: replace it
        </label>
      )}
    </div>
  );
}

function ManualInput({ field: f, value, onChange }: { field: NormalizedField; value: string; onChange: (v: string) => void }) {
  const label = `Your answer for ${f.label}`;
  if (f.options.length > 0) {
    return (
      <select className="answer" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose your answer…</option>
        {f.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="answer"
      aria-label={label}
      type={f.kind === "date" ? "date" : f.kind === "email" ? "email" : "text"}
      inputMode={f.kind === "tel" || f.kind === "number" ? "numeric" : undefined}
      maxLength={f.maxLength ?? 500}
      placeholder="Type your answer (used for this form only)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Everything that will be typed into the page, shown before anything happens. */
export function PreviewView({
  snapshot,
  mapping,
  items,
  busy,
  onBack,
  onConfirm,
}: {
  snapshot: FormSnapshot;
  mapping: MapResult | null;
  items: PlannedItem[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const chosen = new Set(items.map((i) => i.field.id));
  const manualIds = new Set((mapping?.fields ?? []).filter((m) => m.decision === "MANUAL").map((m) => m.fieldId));
  const leftForYou = snapshot.fields.filter((f) => f.visible && !chosen.has(f.id));
  const manual = leftForYou.filter((f) => f.manual || f.kind === "file" || f.kind === "password" || manualIds.has(f.id));
  const list = (fs: NormalizedField[]) => fs.map((f) => f.label.replace(/[.:]+$/, "")).join("; ");
  const requiredOpen = leftForYou.filter((f) => f.required && !manual.includes(f));

  return (
    <div className="stack">
      <div className="card">
        <div className="eyebrow">Step 2 of 3</div>
        <div className="title">Check before filling</div>
        <div className="small muted">
          {items.length} field{items.length === 1 ? "" : "s"} on <b>{snapshot.domain}</b> will be filled. Sensitive numbers are shown masked here and filled in full.
        </div>
        <table className="preview">
          <tbody>
            {items.map((i) => (
              <tr key={i.field.id}>
                <td>{i.field.label}</td>
                <td>
                  <b>{i.display}</b>
                  {i.source === "manual" && <span className="tag">typed by you</span>}
                  {i.mapping && i.mapping.decision !== "AUTO_FILL" && <span className="tag review">you checked</span>}
                  {i.choice.overwrite && <span className="tag">replaces page value</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {requiredOpen.length > 0 && (
        <div className="info">
          <b>Still empty (required):</b> {list(requiredOpen)}. Fill them on the page yourself.
        </div>
      )}
      <div className="warn">
        {manual.length > 0 && (
          <>
            <b>You do these yourself:</b> {list(manual)}.<br />
          </>
        )}
        The assistant never presses <b>Submit</b>. After filling, check the page and submit it yourself.
      </div>

      <div className="row-between">
        <button className="secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button className="primary" onClick={onConfirm} disabled={busy || items.length === 0}>
          {busy ? "Filling…" : `Confirm & fill ${items.length}`}
        </button>
      </div>
    </div>
  );
}

export interface FillOutcome {
  applicationId: string;
  results: FillResult[];
  undone: boolean;
  status: "CONFIRMED" | "SUBMITTED" | "CANCELLED";
  /** Filled by a café operator for this customer. */
  customerName?: string | null;
}

/** What happened on the page, with undo and "I submitted it". */
export function ResultView({
  outcome,
  labels,
  busy,
  onHighlight,
  onUndo,
  onSubmitted,
  onDone,
}: {
  outcome: FillOutcome;
  labels: Map<string, string>;
  busy: boolean;
  onHighlight: (fieldId: string) => void;
  onUndo: () => void;
  onSubmitted: (applicationNumber: string) => void;
  onDone: () => void;
}) {
  const [number, setNumber] = useState("");
  const filled = outcome.results.filter((r) => r.status === "filled");
  const notFilled = outcome.results.filter((r) => r.status !== "filled");

  return (
    <div className="stack">
      <div className="card">
        <div className="result-hero">
          <span className={`ring${outcome.undone ? " undone" : ""}`} aria-hidden="true">
            {outcome.undone ? "↺" : "✓"}
          </span>
          <div>
            <div className="title">{outcome.undone ? "Fill undone" : `Filled ${filled.length} of ${outcome.results.length} fields`}</div>
            {!outcome.undone && <div className="small muted">Filled fields have a green outline on the page.</div>}
          </div>
        </div>
        {notFilled.length > 0 && !outcome.undone && (
          <ul className="fields">
            {notFilled.map((r) => (
              <li key={r.fieldId}>
                <button className="field" onClick={() => onHighlight(r.fieldId)} title="Show on page">
                  <span className="label">
                    {labels.get(r.fieldId) ?? r.fieldId}
                    <span className={`tag ${r.status === "failed" ? "manual" : "review"}`}>{r.status === "failed" ? "Not filled" : "Skipped"}</span>
                  </span>
                  <span className="meta">{r.reason ? FILL_REASON_TEXT[r.reason] : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {outcome.status === "SUBMITTED" ? (
        <div className="info">
          {outcome.customerName
            ? `Saved in ${outcome.customerName}'s application history as submitted. They were notified.`
            : "Saved in your application history as submitted. You can find it in the dashboard."}
        </div>
      ) : (
        !outcome.undone && (
          <div className="card">
            <div className="small">
              Now review the page, complete any CAPTCHA / OTP, and press the website's own Submit button. Then tell us so it is saved in your history:
            </div>
            <label>
              Application / registration number (optional)
              <input value={number} maxLength={100} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. REG2026001234" />
            </label>
            <div className="row-between">
              <button className="secondary" onClick={onUndo} disabled={busy}>
                Undo fill
              </button>
              <button className="primary" onClick={() => onSubmitted(number)} disabled={busy}>
                I submitted this form
              </button>
            </div>
          </div>
        )
      )}
      <button className="link small" onClick={onDone}>
        Back to the form
      </button>
    </div>
  );
}
