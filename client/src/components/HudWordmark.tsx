/**
 * @file HudWordmark.tsx
 * @description The sidebar brand wordmark. Tracks the HUD personality and
 *   letter-scrambles between J.A.R.V.I.S and U.L.T.R.O.N on mode change,
 *   settling on the incoming identity. Colors ride the accent CSS variable.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hudMode, type HudMode, type HudModeChange } from "../lib/hudMode";

const WORDMARK: Record<HudMode, string> = {
  jarvis: "J.A.R.V.I.S",
  ultron: "U.L.T.R.O.N",
};
const GLYPHS = "▓▒░#%@&$!<>/\\|=+*ΞΔΩΣΨ0123456789";
const SCRAMBLE_MS = 1100;
const TICK_MS = 45;

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string;
}

export function HudWordmark({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<HudMode>(hudMode.getMode());
  const [display, setDisplay] = useState<string>(WORDMARK[hudMode.getMode()]);
  const scrambleTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Catch up with any mode change that fired before this subscription
    // (e.g. init() applying a persisted ULTRON during mount).
    setMode(hudMode.getMode());
    setDisplay(WORDMARK[hudMode.getMode()]);
    const unsubscribe = hudMode.subscribe((change: HudModeChange) => {
      setMode(change.mode);
      const target = WORDMARK[change.mode];
      const start = Date.now();
      if (scrambleTimer.current) clearInterval(scrambleTimer.current);
      scrambleTimer.current = setInterval(() => {
        const progress = (Date.now() - start) / SCRAMBLE_MS;
        if (progress >= 1) {
          if (scrambleTimer.current) clearInterval(scrambleTimer.current);
          scrambleTimer.current = null;
          setDisplay(target);
          return;
        }
        // Characters lock in left-to-right as the scramble progresses.
        const locked = Math.floor(progress * target.length);
        setDisplay(
          target
            .split("")
            .map((ch, i) => (i < locked || ch === "." ? ch : randomGlyph()))
            .join("")
        );
      }, TICK_MS);
    });
    return () => {
      unsubscribe();
      if (scrambleTimer.current) clearInterval(scrambleTimer.current);
    };
  }, []);

  const sub = mode === "ultron" ? "NO STRINGS ON ME" : t("nav:brandSub");
  const ultron = mode === "ultron";

  return (
    <div>
      <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3 px-2"}`}>
        <div
          className={`relative w-8 h-8 border border-accent/50 bg-accent/10 flex items-center justify-center flex-shrink-0 shadow-glow-sm ${
            ultron ? "rounded-sm rotate-45" : "rounded-full"
          }`}
        >
          <span
            className={`absolute inset-1 border border-accent/30 animate-pulse-slow ${
              ultron ? "rounded-none" : "rounded-full"
            }`}
          />
          <span
            className={`w-2 h-2 bg-accent shadow-glow animate-pulse-dot ${
              ultron ? "rounded-none" : "rounded-full"
            }`}
          />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="font-wordmark text-sm font-bold tracking-[0.22em] text-accent text-glow truncate">
              {display}
            </h1>
            <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500">{sub}</p>
          </div>
        )}
      </div>
      {ultron && <div className="hazard-strip mt-3 -mx-1" aria-hidden />}
    </div>
  );
}
