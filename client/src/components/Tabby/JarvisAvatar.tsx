/**
 * @file JarvisAvatar.tsx
 * @description Mini-JARVIS avatar - a pocket arc-reactor orb. Pure
 *   presentational SVG: given a mood it renders the matching state via a
 *   `data-mood` attribute driving CSS in tabby.css (rotating tick ring,
 *   breathing nucleus, alert glyphs). The glowing iris tracks the cursor - the
 *   little guy watches you work. Colors ride the --hud-accent CSS variable, so
 *   the companion goes crimson with the rest of the HUD when ULTRON takes
 *   over. No data access - fully testable / reusable in isolation.
 */

import { useEffect, useRef, useState } from "react";
import type { Mood } from "./brain";

interface JarvisAvatarProps {
  mood: Mood;
  reducedMotion: boolean;
  size?: number;
}

const MAX_IRIS_SHIFT = 7; // px in the 100x100 viewBox

// Module-level last-known cursor position, tracked from the moment this module
// first loads (well before any avatar mounts). This is what makes the iris
// tracking feel *immediate*: as soon as the orb mounts it aims at wherever the
// cursor already is, instead of sitting centered until the next mousemove.
let lastCursor: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  const remember = (e: MouseEvent) => {
    lastCursor = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener("mousemove", remember, { capture: true, passive: true });
  window.addEventListener("pointermove", remember as EventListener, {
    capture: true,
    passive: true,
  });
}

const A = (alpha: number) => `rgb(var(--hud-accent) / ${alpha})`;

export function JarvisAvatar({ mood, reducedMotion, size = 60 }: JarvisAvatarProps) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number>();
  const [iris, setIris] = useState({ x: 0, y: 0 });

  // The iris follows the cursor whenever motion is allowed and the core is
  // "awake" (sleeping dims and parks it; disconnected greys out but keeps
  // aiming so it snaps alive the instant the connection returns).
  const tracking = !reducedMotion && mood !== "sleeping";

  useEffect(() => {
    if (!tracking) {
      setIris({ x: 0, y: 0 });
      return;
    }

    const aimAt = (clientX: number, clientY: number) => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = (dx / dist) * Math.min(1, dist / 240);
      const ny = (dy / dist) * Math.min(1, dist / 240);
      setIris({ x: nx * MAX_IRIS_SHIFT, y: ny * MAX_IRIS_SHIFT });
    };

    let initRaf = 0;
    if (lastCursor) {
      const c = lastCursor;
      initRaf = requestAnimationFrame(() => aimAt(c.x, c.y));
    }

    const onMove = (e: MouseEvent) => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = undefined;
        aimAt(e.clientX, e.clientY);
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (initRaf) cancelAnimationFrame(initRaf);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    };
  }, [tracking]);

  return (
    <svg
      ref={rootRef}
      className="mini-jarvis"
      data-mood={mood}
      data-reduced={reducedMotion ? "1" : "0"}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Mini JARVIS (${mood})`}
    >
      <defs>
        <radialGradient id="miniJarvisCore" cx="50%" cy="42%" r="62%">
          <stop offset="0%" stopColor={A(0.85)} />
          <stop offset="45%" stopColor={A(0.35)} />
          <stop offset="100%" stopColor={A(0.05)} />
        </radialGradient>
      </defs>

      {/* ambient halo */}
      <circle className="mj-halo" cx="50" cy="50" r="46" fill={A(0.08)} />

      {/* outer tick ring - rotates while awake, breaks apart when disconnected */}
      <g className="mj-ring-outer">
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke={A(0.55)}
          strokeWidth="2.5"
          strokeDasharray="2 6.2"
        />
      </g>

      {/* middle arc ring - counter-rotates */}
      <g className="mj-ring-mid">
        <circle
          cx="50"
          cy="50"
          r="34"
          fill="none"
          stroke={A(0.4)}
          strokeWidth="1.4"
          strokeDasharray="30 12 14 12"
          strokeLinecap="round"
        />
      </g>

      {/* nucleus */}
      <g className="mj-nucleus">
        <circle
          cx="50"
          cy="50"
          r="24"
          fill="url(#miniJarvisCore)"
          stroke={A(0.6)}
          strokeWidth="1.4"
        />
        <circle
          cx="50"
          cy="50"
          r="17.5"
          fill="none"
          stroke={A(0.3)}
          strokeWidth="1"
          strokeDasharray="2.5 4"
        />
      </g>

      {/* the watching iris - follows your cursor */}
      <g className="mj-iris" style={{ transform: `translate(${iris.x}px, ${iris.y}px)` }}>
        <circle className="mj-iris-dot" cx="50" cy="50" r="6.5" fill={A(0.95)} />
        <circle cx="52.2" cy="47.6" r="2" fill="#eafcff" opacity="0.9" />
      </g>

      {/* sleeping lid - dims the core */}
      <g className="mj-lid">
        <path
          d="M30 50 q20 12 40 0"
          fill="none"
          stroke={A(0.7)}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </g>

      {/* worried - warning arc over the crown (gold, reserved status hue) */}
      <g className="mj-warn">
        <path
          d="M22 30 A 34 34 0 0 1 78 30"
          fill="none"
          stroke="#f0c040"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="5 5"
        />
      </g>

      {/* stuck - alert bang */}
      <g className="mj-bang">
        <text x="76" y="30">
          !
        </text>
      </g>

      {/* sleeping zzz */}
      <g className="mj-zzz">
        <text x="74" y="28">
          z
        </text>
        <text x="83" y="18">
          z
        </text>
      </g>

      {/* happy sparkle */}
      <g className="mj-sparkle">
        <path d="M82 40 l1.4 3.6 l3.6 1.4 l-3.6 1.4 l-1.4 3.6 l-1.4 -3.6 l-3.6 -1.4 l3.6 -1.4 z" />
      </g>
    </svg>
  );
}
