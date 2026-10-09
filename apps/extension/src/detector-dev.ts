/**
 * Development-only build of the detector + filler without any chrome.* APIs,
 * served by the local test-form site at /__dev/detector.js so the extension
 * flow can be tried in any browser:  window.UFADetector.detect()
 * Not included in the extension package.
 */
import { attachFile, detectForm, fillForm, insertEmailDraft, listUploadFields, watchForm, type EmailInsertRun, type FillItem, type FillRun } from "@ufa/form-engine/dom";

let lastRun: FillRun | null = null;
let lastEmail: EmailInsertRun | null = null;

(window as unknown as { UFADetector: unknown }).UFADetector = {
  detect: () => detectForm(document),
  watch: watchForm,
  fill: async (items: FillItem[], visual?: boolean) => {
    lastRun = await fillForm(document, items, { visual: Boolean(visual) });
    return lastRun.results;
  },
  undo: () => {
    const n = lastRun ? lastRun.undo() : 0;
    lastRun = null;
    return n;
  },
  listUploads: () => listUploadFields(document),
  attach: (fieldId: string, name: string, mime: string, base64: string) =>
    attachFile(document, fieldId, new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: mime })),
  insertEmail: (draft: { subject: string; body: string }) => {
    const run = insertEmailDraft(document, draft);
    if (run.result.body === "inserted") lastEmail = run;
    return run.result;
  },
  undoEmail: () => {
    const n = lastEmail?.undo() ? 1 : 0;
    lastEmail = null;
    return n;
  },
};
