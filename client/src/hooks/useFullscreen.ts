/**
 * @file useFullscreen.ts
 * @description Wraps the browser Fullscreen API so components can toggle whole-window
 * fullscreen viewing of the dashboard. Tracks state via the `fullscreenchange` event
 * (not just the toggle call) so the UI stays in sync when the user exits via Esc or
 * browser chrome instead of the in-app button. Exposes `isSupported` because the API
 * is unavailable in some embedded/webview contexts (e.g. certain mobile browsers).
 */

import { useCallback, useEffect, useState } from "react";

function isFullscreenActive(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

export function useFullscreen() {
  const isSupported =
    typeof document !== "undefined" &&
    (document.fullscreenEnabled ??
      typeof document.documentElement?.requestFullscreen === "function");
  const [isFullscreen, setIsFullscreen] = useState(isFullscreenActive);

  useEffect(() => {
    if (!isSupported) return;
    const onChange = () => setIsFullscreen(isFullscreenActive());
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [isSupported]);

  const toggle = useCallback(() => {
    if (!isSupported) return;
    if (isFullscreenActive()) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, [isSupported]);

  return { isFullscreen, isSupported, toggle };
}
