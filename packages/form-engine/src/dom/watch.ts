/**
 * Re-detects when the page changes (spec §20): fields added/removed/shown/hidden
 * (MutationObserver), and SPA navigation (URL polling — pushState in the page's
 * JS world is invisible to an isolated content script).
 */
export interface FormWatcher {
  stop(): void;
}

export function watchForm(doc: Document, onChange: (reason: "dom" | "navigation") => void, opts: { debounceMs?: number; urlPollMs?: number } = {}): FormWatcher {
  const debounceMs = opts.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: "dom" | "navigation" = "dom";
  const fire = (reason: "dom" | "navigation") => {
    if (reason === "navigation") pending = "navigation";
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = pending;
      pending = "dom";
      onChange(r);
    }, debounceMs);
  };

  const relevant = (m: MutationRecord) => {
    if (m.type === "attributes") return true;
    const touches = (nodes: NodeList) =>
      [...nodes].some((n) => n.nodeType === 1 && ((n as Element).matches?.("input,select,textarea,form,fieldset,[role=combobox],[contenteditable]") || (n as Element).querySelector?.("input,select,textarea")));
    return touches(m.addedNodes) || touches(m.removedNodes);
  };

  const observer = new MutationObserver((records) => {
    if (records.some(relevant)) fire("dom");
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "disabled", "aria-hidden", "open", "type"],
  });

  let lastUrl = doc.location?.href;
  const poll = setInterval(() => {
    if (doc.location?.href !== lastUrl) {
      lastUrl = doc.location?.href;
      fire("navigation");
    }
  }, opts.urlPollMs ?? 1000);

  return {
    stop() {
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
    },
  };
}
