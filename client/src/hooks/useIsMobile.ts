/**
 * @file useIsMobile.ts
 * @description Tracks whether the viewport is at or below the mobile breakpoint (Tailwind's `md`, 768px) via a `matchMedia` listener, so layout components can switch between the desktop sidebar shell and the mobile drawer shell.
 */

import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

function getIsMobile(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
