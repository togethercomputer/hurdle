import { readStoredPreference } from "./browser-preference-storage.mjs";

// Viewer settings live in this browser's localStorage, like the theme.
export const SHOW_AGENT_TRAFFIC_KEY = "hurdle-show-agent-traffic";
const CHANGE_EVENT = "hurdle-viewer-settings-change";

/** Off unless this browser turned it on. */
export function readShowAgentTraffic(storage) {
  try {
    return readStoredPreference(storage, SHOW_AGENT_TRAFFIC_KEY) === "true";
  } catch {
    return false;
  }
}

/** Saves the setting and tells this tab's open pages; other tabs get a storage event. */
export function writeShowAgentTraffic(storage, show, target) {
  try {
    storage.setItem(SHOW_AGENT_TRAFFIC_KEY, show ? "true" : "false");
  } catch { /* The page still updates; the choice just isn't remembered. */ }
  target?.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeViewerSettings(target, onChange) {
  target.addEventListener("storage", onChange);
  target.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    target.removeEventListener("storage", onChange);
    target.removeEventListener(CHANGE_EVENT, onChange);
  };
}
