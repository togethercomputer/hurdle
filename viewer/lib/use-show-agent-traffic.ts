"use client";

import { useCallback, useSyncExternalStore } from "react";
import { readShowAgentTraffic, subscribeViewerSettings, writeShowAgentTraffic } from "@/lib/viewer-settings.mjs";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The "Show agent traffic" Viewer setting. Off on the server and by default. */
export function useShowAgentTraffic(): [boolean, (show: boolean) => void] {
  const show = useSyncExternalStore(
    (onChange) => subscribeViewerSettings(window, onChange),
    () => {
      const stored = storage();
      return stored ? readShowAgentTraffic(stored) : false;
    },
    () => false,
  );
  const setShow = useCallback((next: boolean) => {
    const stored = storage();
    if (stored) writeShowAgentTraffic(stored, next, window);
  }, []);
  return [show, setShow];
}
