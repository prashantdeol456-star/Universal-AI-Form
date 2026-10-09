import { attachFile, detectForm, fillForm, findFieldElement, insertEmailDraft, listUploadFields, watchForm, type EmailInsertRun, type FillRun } from "@ufa/form-engine/dom";
import type { AttachFileResponse, ContentToPanel, DetectResponse, FillResponse, InsertEmailResponse, ListUploadsResponse, PanelToContent, UndoResponse } from "./messages";

/**
 * Injected on demand (when the user clicks "Analyze") — never declared for all
 * sites. Reads form structure, and writes only the values the user confirmed
 * in the side panel. Executes no remote or AI-generated code and never submits.
 */
declare global {
  interface Window {
    __ufaContentLoaded?: boolean;
  }
}

if (!window.__ufaContentLoaded) {
  window.__ufaContentLoaded = true;

  let lastSignature = "";
  let watcher: ReturnType<typeof watchForm> | null = null;
  let lastFill: FillRun | null = null;
  let lastEmail: EmailInsertRun | null = null;

  const startWatching = () => {
    watcher ??= watchForm(document, (reason) => {
      const snapshot = detectForm(document);
      // Only notify when the set of visible fields actually changed.
      if (snapshot.formSignature === lastSignature && reason === "dom") return;
      lastSignature = snapshot.formSignature;
      const msg: ContentToPanel = { type: "UFA_FORM_CHANGED", reason, snapshot };
      chrome.runtime.sendMessage(msg).catch(() => {
        // Side panel closed: stop observing until the next explicit Analyze.
        watcher?.stop();
        watcher = null;
      });
    });
  };

  chrome.runtime.onMessage.addListener((msg: PanelToContent, _sender, sendResponse) => {
    if (msg.type === "UFA_PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "UFA_DETECT") {
      try {
        const snapshot = detectForm(document);
        lastSignature = snapshot.formSignature;
        startWatching();
        sendResponse({ ok: true, snapshot } satisfies DetectResponse);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies DetectResponse);
      }
      return;
    }
    if (msg.type === "UFA_FILL") {
      fillForm(document, msg.items, { visual: Boolean(msg.visual) })
        .then((run) => {
          lastFill = run;
          sendResponse({ ok: true, results: run.results } satisfies FillResponse);
        })
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FillResponse));
      return true; // async response
    }
    if (msg.type === "UFA_UNDO") {
      const restored = lastFill ? lastFill.undo() : 0;
      lastFill = null;
      sendResponse({ ok: true, restored } satisfies UndoResponse);
      return;
    }
    if (msg.type === "UFA_LIST_UPLOADS") {
      sendResponse({ ok: true, fields: listUploadFields(document) } satisfies ListUploadsResponse);
      return;
    }
    if (msg.type === "UFA_ATTACH_FILE") {
      try {
        const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
        const outcome = attachFile(document, msg.fieldId, new File([bytes], msg.name, { type: msg.mime }));
        sendResponse({ ok: true, outcome } satisfies AttachFileResponse);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies AttachFileResponse);
      }
      return;
    }
    if (msg.type === "UFA_INSERT_EMAIL") {
      try {
        const run = insertEmailDraft(document, { subject: msg.subject, body: msg.body });
        if (run.result.body === "inserted") lastEmail = run;
        sendResponse({ ok: true, result: run.result } satisfies InsertEmailResponse);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies InsertEmailResponse);
      }
      return;
    }
    if (msg.type === "UFA_UNDO_EMAIL") {
      const restored = lastEmail?.undo() ? 1 : 0;
      lastEmail = null;
      sendResponse({ ok: true, restored } satisfies UndoResponse);
      return;
    }
    if (msg.type === "UFA_HIGHLIGHT") {
      const el = findFieldElement(document, msg.fieldId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = el.style.outline;
        el.style.outline = "3px solid #2453e0";
        setTimeout(() => (el.style.outline = prev), 1600);
      }
      sendResponse({ ok: Boolean(el) });
    }
  });
}

export {};
