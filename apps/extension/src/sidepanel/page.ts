import type { FillItem } from "@ufa/form-engine/dom";
import type { AttachFileResponse, DetectResponse, FillResponse, InsertEmailResponse, ListUploadsResponse, PanelToContent, UndoResponse } from "../messages";
import { originPattern } from "./storage";

export interface ActiveTab {
  id: number;
  url: string | null;
  title: string;
}

export async function getActiveTab(): Promise<ActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return null;
  return { id: tab.id, url: tab.url ?? null, title: tab.title ?? "" };
}

export function isSupportedUrl(url: string | null): boolean {
  return Boolean(url && /^https?:\/\//.test(url) && !/^https:\/\/chrome\.google\.com\/webstore/.test(url));
}

export async function hasSitePermission(url: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

/**
 * When Chrome has not shared even the tab's address (the panel was opened on another
 * tab), no single site can be asked for. The user may allow the assistant on all
 * websites once; it still reads a page only when they press Analyze.
 */
export async function requestAllSitesPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
}

/** "Always allow on this site": persistent permission for one site (must run in a click handler). */
export async function requestSitePermission(url: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPattern(url)] });
}

/**
 * Injects the content script into the tab (works with activeTab right after the
 * icon click, or with a granted site permission) and asks it to detect the form.
 */
export async function analyzeTab(tabId: number): Promise<DetectResponse> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const msg: PanelToContent = { type: "UFA_DETECT" };
  return chrome.tabs.sendMessage(tabId, msg) as Promise<DetectResponse>;
}

export async function highlightField(tabId: number, fieldId: string): Promise<void> {
  const msg: PanelToContent = { type: "UFA_HIGHLIGHT", fieldId };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/** Asks the content script to fill confirmed items (it re-injects if the page was reloaded: then ids are gone and fields report not_found). */
export async function fillTab(tabId: number, items: FillItem[], visual = false): Promise<FillResponse> {
  const msg: PanelToContent = { type: "UFA_FILL", items, visual };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as FillResponse;
  } catch {
    return { ok: false, error: "The page was reloaded or closed. Analyze the form again." };
  }
}

export async function undoFillTab(tabId: number): Promise<UndoResponse> {
  const msg: PanelToContent = { type: "UFA_UNDO" };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as UndoResponse;
  } catch {
    return { ok: false, error: "The page was reloaded or closed, so there is nothing to undo." };
  }
}

/** Injects the content script (activeTab or site permission) and puts the approved draft into the compose window. */
export async function insertEmailIntoTab(tabId: number, draft: { subject: string; body: string }): Promise<InsertEmailResponse> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const msg: PanelToContent = { type: "UFA_INSERT_EMAIL", ...draft };
    return (await chrome.tabs.sendMessage(tabId, msg)) as InsertEmailResponse;
  } catch {
    return { ok: false, error: "This page cannot be accessed. Click the extension icon on the email page, then try again." };
  }
}

export async function undoEmailInTab(tabId: number): Promise<UndoResponse> {
  const msg: PanelToContent = { type: "UFA_UNDO_EMAIL" };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as UndoResponse;
  } catch {
    return { ok: false, error: "The page was reloaded or closed, so there is nothing to undo." };
  }
}

/** Upload fields on the page (the content script is already injected by Analyze). */
export async function listUploadsInTab(tabId: number): Promise<ListUploadsResponse> {
  const msg: PanelToContent = { type: "UFA_LIST_UPLOADS" };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as ListUploadsResponse;
  } catch {
    return { ok: false, error: "The page was reloaded. Analyze it again." };
  }
}

export async function attachFileInTab(tabId: number, file: { fieldId: string; name: string; mime: string; base64: string }): Promise<AttachFileResponse> {
  const msg: PanelToContent = { type: "UFA_ATTACH_FILE", ...file };
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as AttachFileResponse;
  } catch {
    return { ok: false, error: "The page was reloaded. Analyze it again." };
  }
}
