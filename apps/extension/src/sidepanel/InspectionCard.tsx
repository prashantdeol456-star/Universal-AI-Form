import type { InspectionSummary } from "../messages";

const ROLE_TEXT = { submit: "submit", next: "next page", save: "save", payment: "payment", other: "" } as const;

/**
 * What the assistant found on the page, before anything is filled: the form, its buttons
 * (none of which the assistant clicks), fields it ignores, and warnings about the page itself.
 */
export function InspectionCard({ inspection: i, fieldCount }: { inspection: InspectionSummary; fieldCount: number }) {
  const buttons = i.forms.flatMap((f) => f.buttons).filter((b) => b.role !== "other");
  const crossSite = i.forms.filter((f) => f.crossOrigin);
  return (
    <div className="card inspection">
      <div className="eyebrow">Page check</div>
      <div className="small">
        <b>{i.headings[0] ?? i.title ?? "This page"}</b>
        <div className="muted">
          {fieldCount} visible field{fieldCount === 1 ? "" : "s"}
          {i.forms.length ? ` in ${i.forms.length} form${i.forms.length === 1 ? "" : "s"}` : ""}
          {i.hiddenFieldCount > 0 ? ` · ${i.hiddenFieldCount} hidden field${i.hiddenFieldCount === 1 ? "" : "s"} ignored` : ""}
          {i.truncated ? " · very long form, only the first part was read" : ""}
        </div>
      </div>
      {buttons.length > 0 && (
        <div className="small muted">
          Buttons found: {buttons.map((b) => `“${b.text}”${ROLE_TEXT[b.role] ? ` (${ROLE_TEXT[b.role]})` : ""}`).join(", ")}. The assistant never clicks them; you do.
        </div>
      )}
      {i.injection.length > 0 && (
        <div className="warn small" role="alert">
          <b>This page contains text aimed at AI assistants.</b> It is ignored: the assistant only fills the fields you approve and never submits, sends or uploads on
          a page&apos;s request.
          <ul className="inspect-list">
            {i.injection.slice(0, 3).map((x, n) => (
              <li key={n}>
                {x.where === "hidden_text" ? "Hidden text" : x.where === "label" ? "Field label" : "Page text"} {x.reason}: “{x.excerpt}”
              </li>
            ))}
          </ul>
        </div>
      )}
      {crossSite.length > 0 && (
        <div className="warn small">
          This form sends its data to another website ({crossSite.map((f) => f.actionOrigin?.replace(/^https?:\/\//, "")).join(", ")}). Check that you trust it before you submit.
        </div>
      )}
      {i.dangerousLinks > 0 && <div className="muted small">{i.dangerousLinks} script link(s) on the page are ignored.</div>}
    </div>
  );
}
