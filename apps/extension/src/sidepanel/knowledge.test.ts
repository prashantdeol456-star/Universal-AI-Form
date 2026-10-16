import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import type { FieldEvidence, FieldMappingView, MapResult } from "./api";
import { plannedItems, sourceText } from "./Fill";
import { EvidenceNote } from "./FormSummary";

function field(id: string, label: string): NormalizedField {
  return {
    id, kind: "text", label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: true, options: [],
    autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true, disabled: false, readOnly: false,
    hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false,
  };
}
function mapped(f: NormalizedField, value: string | null, evidence: FieldEvidence, extra: Partial<FieldMappingView> = {}): FieldMappingView {
  return {
    fieldId: f.id, profileFieldKey: "employment.company", profileFieldLabel: "Current Company", profileFieldLabelHi: null, value, valueVerified: evidence.status === "verified",
    optionMatch: null, confidence: 0.95, decision: value ? "AUTO_FILL" : "ASK_USER", reason: "confident", sources: ["rules"], candidates: [], savedAnswer: null, evidence, ...extra,
  };
}
const html = (m: FieldMappingView, onUse?: () => void) => renderToStaticMarkup(createElement(EvidenceNote, { m, onUse }));

describe("evidence in the side panel (knowledge base)", () => {
  const f = field("f1", "Current employer");

  it("names the document a confirmed value came from", () => {
    const m = mapped(f, "Acme Logistics", { status: "verified", origin: "document", document: { id: "d1", title: "cv.pdf" }, suggestion: null });
    expect(html(m)).toMatch(/From your document “cv.pdf”, confirmed by you/);
    const snap = { fields: [f] } as unknown as FormSnapshot;
    const item = plannedItems(snap, { fields: [m] } as unknown as MapResult, {})[0]!;
    expect(sourceText(item)).toMatch(/verified in your profile \(from “cv.pdf”\)/);
  });

  it("warns about conflicting sources and says it is not filled automatically", () => {
    const m = mapped(f, "Acme", { status: "conflicting", origin: "user_input", document: null, suggestion: null }, { decision: "USER_REVIEW", reason: "conflicting_sources" });
    expect(html(m)).toMatch(/Different values in your profile and documents/);
    const item = plannedItems({ fields: [f] } as unknown as FormSnapshot, { fields: [m] } as unknown as MapResult, { f1: { include: true, manualValue: "", overwrite: false } })[0]!;
    expect(sourceText(item)).toMatch(/your sources disagree/);
  });

  it("offers an unconfirmed document value only as the user's own choice, never for masked values", () => {
    const m = mapped(f, null, { status: "unconfirmed_document", origin: null, document: null, suggestion: { value: "Acme Logistics", documentId: "d1", documentTitle: "cv.pdf" } });
    expect(html(m, () => {})).toMatch(/Found in “cv.pdf”: <b>Acme Logistics<\/b> \(not confirmed\)/);
    expect(html(m, () => {})).toMatch(/Use it for this form/);
    // Not planned until the user picks it.
    const snap = { fields: [f] } as unknown as FormSnapshot;
    expect(plannedItems(snap, { fields: [m] } as unknown as MapResult, {})).toEqual([]);
    const chosen = plannedItems(snap, { fields: [m] } as unknown as MapResult, { f1: { include: true, manualValue: "Acme Logistics", overwrite: false, fromDocument: "cv.pdf" } })[0]!;
    expect(sourceText(chosen)).toBe("from “cv.pdf” (not confirmed, chosen by you)");
    const masked = mapped(f, null, { status: "unconfirmed_document", origin: null, document: null, suggestion: { value: "••••••••1234", documentId: "d1", documentTitle: "cv.pdf" } });
    expect(html(masked, () => {})).not.toMatch(/Use it for this form/);
  });

  it("shows nothing for missing evidence or café mode", () => {
    expect(html(mapped(f, null, { status: "missing", origin: null, document: null, suggestion: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(EvidenceNote, { m: { ...mapped(f, "x", { status: "verified", origin: null, document: null, suggestion: null }), evidence: null } }))).toBe("");
  });
});
