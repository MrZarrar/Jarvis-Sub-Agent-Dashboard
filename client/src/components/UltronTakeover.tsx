/**
 * @file UltronTakeover.tsx
 * @description Full-screen glitch transition played on every HUD personality
 *   flip (JARVIS ↔ ULTRON). Purely decorative: pointer-events pass through
 *   and the overlay removes itself after the animation. The colors ride the
 *   incoming mode's CSS variables, so the same markup glitches crimson on
 *   takeover and cyan on restore.
 */

import { useEffect, useState } from "react";
import type { HudModeChange } from "../lib/hudMode";

const TAKEOVER_MS = 1600;
const SLICE_COUNT = 7;

interface Slice {
  top: number;
  height: number;
  delay: number;
}

function makeSlices(): Slice[] {
  return Array.from({ length: SLICE_COUNT }, () => ({
    top: Math.random() * 92,
    height: 2 + Math.random() * 7,
    delay: Math.random() * 0.35,
  }));
}

export function UltronTakeover() {
  const [playing, setPlaying] = useState<{ key: number; slices: Slice[] } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<HudModeChange>).detail;
      if (!detail) return;
      setPlaying({ key: Date.now(), slices: makeSlices() });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPlaying(null), TAKEOVER_MS);
    };
    window.addEventListener("hud:modechange", onChange);
    return () => {
      window.removeEventListener("hud:modechange", onChange);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!playing) return null;

  return (
    <div className="hud-takeover" key={playing.key} aria-hidden>
      <div className="hud-takeover-static" />
      <div className="hud-takeover-pulse" />
      {playing.slices.map((s, i) => (
        <div
          key={i}
          className="hud-takeover-slice"
          style={{
            top: `${s.top}%`,
            height: `${s.height}%`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
