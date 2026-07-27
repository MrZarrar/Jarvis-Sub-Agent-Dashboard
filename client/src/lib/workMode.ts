/**
 * @file workMode.ts
 * @description Work-mode switch (Phase BM) - DEV (the default dashboard) vs
 * BUSINESS (the FBA/eBay reselling workflow: business todo lane, business
 * agent workspace, dev-only surfaces hidden from the nav). Persisted in
 * localStorage; changes fire a window CustomEvent("work:modechange") so any
 * mounted page can re-fetch. The vault/notes are shared across modes - only
 * the todo lane and nav are partitioned.
 */

import { useEffect, useState } from "react";

export type WorkMode = "dev" | "business";

const KEY = "work-mode";
export const WORK_MODE_EVENT = "work:modechange";

/** Default working directory for business-mode runs (the agent workspace). */
export const BUSINESS_WORKSPACE = "~/JarvisBusiness";

export function getWorkMode(): WorkMode {
  try {
    return localStorage.getItem(KEY) === "business" ? "business" : "dev";
  } catch {
    return "dev";
  }
}

export function setWorkMode(mode: WorkMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* best-effort */
  }
  try {
    window.dispatchEvent(new CustomEvent<WorkMode>(WORK_MODE_EVENT, { detail: mode }));
  } catch {
    /* non-DOM context */
  }
}

/** React hook: the current mode, re-rendering on toggle from anywhere. */
export function useWorkMode(): WorkMode {
  const [mode, setMode] = useState<WorkMode>(getWorkMode);
  useEffect(() => {
    const onChange = () => setMode(getWorkMode());
    window.addEventListener(WORK_MODE_EVENT, onChange);
    return () => window.removeEventListener(WORK_MODE_EVENT, onChange);
  }, []);
  return mode;
}
