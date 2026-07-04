/**
 * @file HoloSpark.tsx
 * @description Sparkline instrument for the command bridge - a headline
 *   number with a trailing trend line beneath it, so magnitude *and* recent
 *   direction read at a glance instead of a bare digit. Sibling of
 *   `HoloStat`/`HoloGauge`; shares the same holo-panel boot/float chrome.
 */

import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import { Tip } from "./Tip";
import { StatValueSkeleton } from "./Skeleton";

interface HoloSparkProps {
  label: string;
  icon: LucideIcon;
  value: string | number;
  /** Recent samples, oldest first. Rendered as an area + line sparkline. */
  points: number[];
  trend?: string;
  index?: number;
  raw?: string;
  loading?: boolean;
}

const W = 120;
const H = 32;

export function HoloSpark({
  label,
  icon: Icon,
  value,
  points,
  trend,
  index = 0,
  raw,
  loading = false,
}: HoloSparkProps) {
  const gradientId = `spark-fill-${useId()}`;
  const max = Math.max(1, ...points);
  const stepX = points.length > 1 ? W / (points.length - 1) : W;
  const coords = points.map((v, i) => {
    const x = i * stepX;
    const y = H - (Math.max(0, v) / max) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = coords.length > 1 ? `M ${coords.join(" L ")}` : "";
  const areaPath = coords.length > 1 ? `M 0,${H} L ${coords.join(" L ")} L ${W},${H} Z` : "";

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
          <div className="min-w-0">
            <div className="flex items-end gap-2 min-w-0 mb-1.5">
              <span className="text-2xl font-semibold text-gray-100 font-mono truncate text-glow">
                {value}
              </span>
              {trend && (
                <span className="text-[11px] text-gray-500 mb-1 flex-shrink-0">{trend}</span>
              )}
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="w-full h-8"
              aria-hidden
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--hud-accent))" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="rgb(var(--hud-accent))" stopOpacity="0" />
                </linearGradient>
              </defs>
              {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
              {linePath && (
                <path
                  d={linePath}
                  fill="none"
                  stroke="rgb(var(--hud-accent))"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {coords.length === 0 && (
                <line
                  x1="0"
                  y1={H - 2}
                  x2={W}
                  y2={H - 2}
                  stroke="rgb(var(--hud-accent) / 0.2)"
                  strokeWidth="1.5"
                />
              )}
            </svg>
          </div>
        </Tip>
      )}
    </div>
  );
}
