/**
 * @file CatAvatar.tsx
 * @description Pure presentational SVG cat - Tabby. Given a mood it renders the
 *   matching expression (ears, eyes, cheeks, mouth, tail, paws) via a `data-mood`
 *   attribute that drives the CSS in tabby.css. When motion is allowed, the
 *   pupils track the cursor. No data access - fully testable / reusable in
 *   isolation. Geometry tuned for max cuteness: big round head, oversized
 *   sparkly eyes, pink ear-insides + cheek blush, classic tabby forehead
 *   stripes, a fluffy tail, and little paws peeking at the bottom.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect, useRef, useState } from "react";
import type { Mood } from "./brain";

interface CatAvatarProps {
  mood: Mood;
  reducedMotion: boolean;
  size?: number;
}

const MAX_PUPIL_SHIFT = 2.8; // px in the 100x100 viewBox

// Module-level last-known cursor position, tracked from the moment this module
// first loads (well before any avatar mounts). This is what makes eye tracking
// feel *immediate*: as soon as the cat mounts it aims at wherever the cursor
// already is, instead of sitting centered until the next mousemove. `null`
// until the very first pointer event of the page's life.
let lastCursor: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  const remember = (e: MouseEvent) => {
    lastCursor = { x: e.clientX, y: e.clientY };
  };
  // capture phase + passive so we never interfere with anything else.
  window.addEventListener("mousemove", remember, { capture: true, passive: true });
  window.addEventListener("pointermove", remember as EventListener, {
    capture: true,
    passive: true,
  });
}

export function CatAvatar({ mood, reducedMotion, size = 60 }: CatAvatarProps) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number>();
  const [pupil, setPupil] = useState({ x: 0, y: 0 });

  // Pupils follow the cursor whenever motion is allowed and the eyes are open.
  // (Only `sleeping` closes them by intent; `disconnected` hides the open-eye
  // group via CSS, so tracking there is harmless and keeps eyes pre-aimed for
  // the instant the connection returns.)
  const tracking = !reducedMotion && mood !== "sleeping";

  useEffect(() => {
    if (!tracking) {
      setPupil({ x: 0, y: 0 });
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
      // Normalize then clamp to the eye socket range.
      const nx = (dx / dist) * Math.min(1, dist / 240);
      const ny = (dy / dist) * Math.min(1, dist / 240);
      setPupil({ x: nx * MAX_PUPIL_SHIFT, y: ny * MAX_PUPIL_SHIFT });
    };

    // Immediately aim at the last-known cursor (next frame, so layout is ready)
    // - no waiting for the user to move the mouse first.
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
      className="tabby-cat"
      data-mood={mood}
      data-reduced={reducedMotion ? "1" : "0"}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Tabby (${mood})`}
    >
      <defs>
        {/* Soft top-lit gradient for the body/head - gives a rounded, plush feel. */}
        <radialGradient id="tabbyFur" cx="50%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#5b5b86" />
          <stop offset="60%" stopColor="#43436a" />
          <stop offset="100%" stopColor="#343352" />
        </radialGradient>
        <linearGradient id="tabbyHalo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a5b4fc" />
          <stop offset="100%" stopColor="#00c2e8" />
        </linearGradient>
      </defs>

      {/* soft glow halo */}
      <circle className="tabby-halo" cx="50" cy="56" r="33" />

      {/* tail - fluffy curl to the right */}
      <path
        className="tabby-tail"
        d="M78 74 q24 4 19 -22 q-3 -14 -12 -11 q8 4 6 14 q-3 12 -16 9 z"
      />

      {/* body / chest peeking up from the bottom */}
      <ellipse className="tabby-body" cx="50" cy="92" rx="27" ry="18" />

      {/* paws */}
      <g className="tabby-paws">
        <ellipse className="tabby-paw" cx="38" cy="98" rx="8" ry="6" />
        <ellipse className="tabby-paw" cx="62" cy="98" rx="8" ry="6" />
        <path className="tabby-toe" d="M35 96 v4 M38 96.5 v4 M41 96 v4" />
        <path className="tabby-toe" d="M59 96 v4 M62 96.5 v4 M65 96 v4" />
      </g>

      {/* ears - rounded, with pink inner */}
      <g className="tabby-ears">
        <path className="tabby-ear" d="M30 33 Q20 8 44 24 Q38 28 34 33 Z" />
        <path className="tabby-ear-inner" d="M31 30 Q26 16 39 25 Q35 27 33 30 Z" />
        <path className="tabby-ear" d="M70 33 Q80 8 56 24 Q62 28 66 33 Z" />
        <path className="tabby-ear-inner" d="M69 30 Q74 16 61 25 Q65 27 67 30 Z" />
      </g>

      {/* head - big and round */}
      <ellipse className="tabby-head" cx="50" cy="49" rx="33" ry="30" />

      {/* classic tabby forehead stripes */}
      <g className="tabby-stripes">
        <path d="M50 22 L50 31" />
        <path d="M43 24 L45 32" />
        <path d="M57 24 L55 32" />
      </g>

      {/* cheek blush */}
      <g className="tabby-cheeks">
        <ellipse cx="26" cy="57" rx="6.5" ry="4" />
        <ellipse cx="74" cy="57" rx="6.5" ry="4" />
      </g>

      {/* eyes - open state (big + sparkly) */}
      <g className="tabby-eyes-open">
        <ellipse className="tabby-eye" cx="37" cy="50" rx="9.5" ry="11.5" />
        <ellipse className="tabby-eye" cx="63" cy="50" rx="9.5" ry="11.5" />
        {/* Outer group carries the eye-tracking translate; the inner group
            carries the blink (scaleY) animation. They MUST be separate
            elements - a CSS animation on `transform` overrides an inline
            `transform`, so putting both on one node makes the blink clobber
            the tracking (the original "eyes only track after a while" bug). */}
        <g className="tabby-pupils" style={{ transform: `translate(${pupil.x}px, ${pupil.y}px)` }}>
          <g className="tabby-pupils-blink">
            <circle className="tabby-pupil" cx="37" cy="51" r="5.4" />
            <circle className="tabby-pupil" cx="63" cy="51" r="5.4" />
            <circle className="tabby-glint" cx="39.4" cy="48" r="2.1" />
            <circle className="tabby-glint" cx="65.4" cy="48" r="2.1" />
            <circle className="tabby-glint tabby-glint-sm" cx="34.8" cy="53" r="1.1" />
            <circle className="tabby-glint tabby-glint-sm" cx="60.8" cy="53" r="1.1" />
          </g>
        </g>
      </g>

      {/* eyes - happy (^ ^) */}
      <g className="tabby-eyes-happy">
        <path d="M29 52 q8 -10 16 0" />
        <path d="M55 52 q8 -10 16 0" />
      </g>

      {/* eyes - closed (sleeping / offline) */}
      <g className="tabby-eyes-closed">
        <path d="M29 51 q8 7 16 0" />
        <path d="M55 51 q8 7 16 0" />
      </g>

      {/* worried brows */}
      <g className="tabby-brows">
        <path d="M29 39 L45 45" />
        <path d="M71 39 L55 45" />
      </g>

      {/* nose - tiny heart */}
      <path
        className="tabby-nose"
        d="M50 64 C47 60 43 62 45 65 C46 67 50 69 50 69 C50 69 54 67 55 65 C57 62 53 60 50 64 Z"
      />

      {/* mouths */}
      <path className="tabby-mouth-idle" d="M50 67 q-4 4 -8 1 M50 67 q4 4 8 1" />
      <path className="tabby-mouth-happy" d="M42 66 q8 7 16 0" />
      <path className="tabby-mouth-worried" d="M44 71 q6 -5 12 0" />

      {/* whiskers */}
      <g className="tabby-whiskers">
        <path d="M14 55 Q24 55 33 58" />
        <path d="M13 62 Q24 63 33 63" />
        <path d="M86 55 Q76 55 67 58" />
        <path d="M87 62 Q76 63 67 63" />
      </g>

      {/* zzz for sleeping */}
      <g className="tabby-zzz">
        <text x="76" y="28">
          z
        </text>
        <text x="84" y="19">
          z
        </text>
      </g>

      {/* alert bang for stuck */}
      <g className="tabby-bang">
        <text x="80" y="28">
          !
        </text>
      </g>

      {/* sparkle for happy */}
      <g className="tabby-sparkle">
        <path d="M82 40 l1.4 3.6 l3.6 1.4 l-3.6 1.4 l-1.4 3.6 l-1.4 -3.6 l-3.6 -1.4 l3.6 -1.4 z" />
      </g>
    </svg>
  );
}
