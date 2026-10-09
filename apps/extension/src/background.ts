/**
 * Service worker. Kept minimal: it only makes the toolbar icon open the side
 * panel. All work happens in the side panel (UI + API calls) and the content
 * script (DOM reading), so nothing runs in the background on pages you visit.
 */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
