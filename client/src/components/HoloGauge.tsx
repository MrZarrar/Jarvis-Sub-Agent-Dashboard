/**
 * @file HoloGauge.tsx
 * @description Radial-dial instrument for the command bridge — a compact
 *   circular gauge (value as an arc fill, 0-100%) with an optional reference
 *   tick mark (e.g. "this week's average") so a single number reads as a
 *   position relative to a baseline instead of a bare digit. Sibling of
 *   `HoloStat`/`HoloSpark`; shares the same holo-panel boot/float chrome.
 */

import type { LucideIcon } from "lucide-react";
import { Tip } from "./Tip";
import { StatValueSkeleton } from "./Skeleton";

interface HoloGaugeProps {
  label: string;
  icon: LucideIcon;
  /** Formatted headline value, e.g. "$12.34". */
  value: string;
  /** Arc fill, 0-100. */
  pct: number;
  /** Optional secondary tick mark on the ring, 0-100 (e.g. week average). */
  referencePct?: number;
  /** Small caption under the dial, e.g. "wk avg $8.20". */
  referenceLabel?: string;
  /** Stroke color for the fill arc; defaults to the HUD accent. */
  color?: string;
  index?: number;
  raw?: string;
  loading?: boolean;
}

const R = 24;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function HoloGauge({
  label,
  icon: Icon,
  value,
  pct,
  referencePct,
  referenceLabel,
  color,
  index = 0,
  raw,
  loading = false,
}: HoloGaugeProps) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const fillLength = (clampedPct / 100) * CIRCUMFERENCE;
  const stroke = color ?? "rgb(var(--hud-accent))";

  const refAngle =
    typeof referencePct === "number"
      ? (Math.max(0, Math.min(100, referencePct)) / 100) * 360 - 90
      : null;

  return (
    <div
      className="holo-panel hud-frame holo-boot holo-float p-4"
      style={
        {
          "--boot-delay": `${index * 0.12}s`,
          "--float-delay": `${(index % 3) * 1.4 + (index % 2) * 0.6}s`,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="hud-label truncate">{label}</span>
        <Icon className="w-4 h-4 flex-shrink-0 text-accent/70" />
      </div>
      {loading ? (
        <StatValueSkeleton />
      ) : (
        <Tip raw={raw}>
          <div className="flex items-center gap-3 min-w-0">
            <svg width={56} height={56} viewBox="0 0 60 60" className="flex-shrink-0">
              <circle
                cx="30"
                cy="30"
                r={R}
                fill="none"
                stroke="rgb(var(--hud-accent) / 0.15)"
                strokeWidth="6"
              />
              <circle
                cx="30"
                cy="30"
                r={R}
                fill="none"
                stroke={stroke}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${fillLength} ${CIRCUMFERENCE - fillLength}`}
                transform="rotate(-90 30 30)"
                style={{ transition: "stroke-dasharray 0.6s ease" }}
              />
              {refAngle !== null && (
                <line
                  x1={30 + (R - 5) * Math.cos((refAngle * Math.PI) / 180)}
                  y1={30 + (R - 5) * Math.sin((refAngle * Math.PI) / 180)}
                  x2={30 + (R + 5) * Math.cos((refAngle * Math.PI) / 180)}
                  y2={30 + (R + 5) * Math.sin((refAngle * Math.PI) / 180)}
                  stroke="rgb(var(--hud-chroma) / 0.9)"
                  strokeWidth="2"
                />
              )}
            </svg>
            <div className="min-w-0">
              <span className="text-xl font-semibold text-gray-100 font-mono truncate text-glow block">
                {value}
              </span>
              {referenceLabel && (
                <span className="text-[10px] text-gray-500 truncate block">{referenceLabel}</span>
              )}
            </div>
          </div>
        </Tip>
      )}
    </div>
  );
}
