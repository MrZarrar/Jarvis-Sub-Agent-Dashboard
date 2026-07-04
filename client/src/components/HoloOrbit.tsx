/**
 * @file HoloOrbit.tsx
 * @description Orbiting-dot instrument for the command bridge - replaces the
 *   separate "active agents" / "active subagents" stat tiles with one
 *   instrument: a live count at the center, ringed by dots representing
 *   individual agents (working = animated cyan, waiting = amber pulse).
 *   Sibling of `HoloStat`/`HoloGauge`/`HoloSpark`.
 */

import type { LucideIcon } from "lucide-react";
import { Tip } from "./Tip";
import { StatValueSkeleton } from "./Skeleton";

interface HoloOrbitProps {
  label: string;
  icon: LucideIcon;
  working: number;
  waiting: number;
  trend?: string;
  index?: number;
  raw?: string;
  loading?: boolean;
}

/** Cap the number of rendered dots so a busy fleet doesn't turn into noise. */
const MAX_DOTS = 8;

function dotPosition(index: number, total: number, radius: number) {
  const angle = (360 / total) * index - 90;
  const rad = (angle * Math.PI) / 180;
  return { x: 30 + radius * Math.cos(rad), y: 30 + radius * Math.sin(rad) };
}

export function HoloOrbit({
  label,
  icon: Icon,
  working,
  waiting,
  trend,
  index = 0,
  raw,
  loading = false,
}: HoloOrbitProps) {
  const total = working + waiting;
  const shown = Math.min(total, MAX_DOTS);
  // Proportionally split the capped dot budget between working/waiting,
  // guaranteeing at least one dot for a status that has any agents at all.
  const workingDots =
    total > 0 ? Math.max(working > 0 ? 1 : 0, Math.round((shown * working) / total)) : 0;
  const waitingDots = Math.max(0, shown - workingDots);
  const overflow = total - shown;

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
            <svg
              width={56}
              height={56}
              viewBox="0 0 60 60"
              className="flex-shrink-0 overflow-visible"
            >
              <circle cx="30" cy="30" r="22" fill="none" stroke="rgb(var(--hud-accent) / 0.15)" />
              <g className="holo-orbit-spin">
                {Array.from({ length: workingDots }, (_, i) => {
                  const { x, y } = dotPosition(i, shown, 22);
                  return (
                    <circle
                      key={`w${i}`}
                      cx={x}
                      cy={y}
                      r="3"
                      fill="#34d399"
                      className="animate-pulse-dot"
                    />
                  );
                })}
                {Array.from({ length: waitingDots }, (_, i) => {
                  const { x, y } = dotPosition(workingDots + i, shown, 22);
                  return (
                    <circle
                      key={`x${i}`}
                      cx={x}
                      cy={y}
                      r="3"
                      fill="#fbbf24"
                      className="animate-pulse-dot"
                    />
                  );
                })}
              </g>
              <text
                x="30"
                y="31"
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-gray-100"
                fontSize="16"
                fontWeight="700"
                fontFamily="monospace"
              >
                {total}
              </text>
            </svg>
            <div className="min-w-0">
              <span className="text-[11px] text-emerald-400 font-mono block">
                {working} working
              </span>
              <span className="text-[11px] text-amber-400 font-mono block">{waiting} waiting</span>
              {(trend || overflow > 0) && (
                <span className="text-[10px] text-gray-500 truncate block">
                  {trend}
                  {overflow > 0 ? ` · +${overflow} more` : ""}
                </span>
              )}
            </div>
          </div>
        </Tip>
      )}
    </div>
  );
}
