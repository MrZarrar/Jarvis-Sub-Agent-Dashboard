/**
 * @file HoloStat.tsx
 * @description Floating holographic stat panel for the command bridge —
 *   scanlined translucent panel that boots in with a flicker and levitates,
 *   staggered by index so the bridge feels alive rather than synchronized.
 */

import type { LucideIcon } from "lucide-react";
import { Tip } from "./Tip";
import { StatValueSkeleton } from "./Skeleton";

interface HoloStatProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  trend?: string;
  /** Stagger position — offsets the boot flicker and float phase. */
  index?: number;
  raw?: string;
  loading?: boolean;
}

export function HoloStat({
  label,
  value,
  icon: Icon,
  trend,
  index = 0,
  raw,
  loading = false,
}: HoloStatProps) {
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
      <div className="flex items-end gap-2 min-w-0">
        {loading ? (
          <StatValueSkeleton />
        ) : (
          <Tip raw={raw}>
            <span className="text-2xl font-semibold text-gray-100 font-mono truncate text-glow">
              {value}
            </span>
          </Tip>
        )}
        {!loading && trend && (
          <span className="text-[11px] text-gray-500 mb-1 flex-shrink-0">{trend}</span>
        )}
      </div>
    </div>
  );
}
