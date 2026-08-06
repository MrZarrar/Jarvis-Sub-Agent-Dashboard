import { useEffect, useState } from "react";

export type WorkMode = "dev" | "business";

const KEY = "work-mode";
export const WORK_MODE_EVENT = "work:modechange";
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
    // Persistence is best-effort in non-browser contexts.
  }
  try {
    window.dispatchEvent(new CustomEvent<WorkMode>(WORK_MODE_EVENT, { detail: mode }));
  } catch {
    // Ignore non-DOM contexts.
  }
}

export function useWorkMode(): WorkMode {
  const [mode, setMode] = useState<WorkMode>(getWorkMode);
  useEffect(() => {
    const onChange = () => setMode(getWorkMode());
    window.addEventListener(WORK_MODE_EVENT, onChange);
    return () => window.removeEventListener(WORK_MODE_EVENT, onChange);
  }, []);
  return mode;
}
