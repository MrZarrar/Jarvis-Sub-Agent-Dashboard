import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { formatCountdown } from "../lib/format";
import type { CodexUsage, SessionWindow } from "../lib/types";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resetLabel(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  return `Resets in ${formatCountdown(Math.max(0, Date.parse(resetsAt) - nowMs))}`;
}

function UsageRow({
  label,
  usedPercent,
  resetsAt,
  unavailableLabel = "Unavailable",
  nowMs,
  tone,
}: {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  unavailableLabel?: string;
  nowMs: number;
  tone: "claude" | "codex";
}) {
  const color = tone === "claude" ? "#c084fc" : "#22d3ee";
  const reset = resetLabel(resetsAt, nowMs);
  return (
    <div className="space-y-1.5" data-testid={`usage-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-baseline justify-between gap-3 font-mono">
        <span className="text-[11px] uppercase tracking-[0.16em] text-gray-400">{label}</span>
        <span className="text-xs font-semibold text-gray-200">
          {usedPercent == null ? unavailableLabel : `${Math.round(usedPercent)}% used`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full border border-white/10 bg-black/25">
        {usedPercent == null ? (
          <div
            className="h-full opacity-30"
            style={{
              backgroundImage: `repeating-linear-gradient(135deg, transparent 0 5px, ${color} 5px 6px)`,
            }}
          />
        ) : (
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${clampPercent(usedPercent)}%`, backgroundColor: color, boxShadow: `0 0 9px ${color}` }}
          />
        )}
      </div>
      <p className="min-h-3 text-right font-mono text-[9px] uppercase tracking-wider text-gray-600">
        {reset ?? "No reset data"}
      </p>
    </div>
  );
}

export function SessionUsagePanel({
  claude,
  codex,
  codexUnavailable = false,
}: {
  claude?: SessionWindow;
  codex: CodexUsage | null;
  codexUnavailable?: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasReset = Boolean(claude?.resetsAt || codex?.fiveHour?.resetsAt || codex?.weekly?.resetsAt);

  useEffect(() => {
    if (!hasReset) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [hasReset]);

  const claudePercent = claude?.percentUsed ?? null;
  const claudeUnavailableLabel = claude && claude.percentUsed == null ? "Usage unavailable" : "Unavailable";
  const codexUnavailableLabel = codexUnavailable ? "Unavailable" : "No usage data";

  return (
    <section className="holo-card relative overflow-hidden rounded-2xl border border-accent/20 bg-surface-2/80 px-4 py-3 shadow-[inset_0_0_28px_rgb(var(--hud-accent)/0.04)]">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-accent" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-200">Session usage</h2>
        <span className="ml-auto text-[9px] uppercase tracking-widest text-gray-600">Subscription limits</span>
      </div>
      <div className="space-y-2.5">
        <UsageRow
          label="Claude"
          usedPercent={claudePercent}
          resetsAt={claude?.active ? claude.resetsAt : null}
          unavailableLabel={claudeUnavailableLabel}
          nowMs={nowMs}
          tone="claude"
        />
        <div className="grid grid-cols-2 gap-3 border-t border-white/5 pt-2.5">
          <UsageRow
            label="Codex 5h"
            usedPercent={codex?.fiveHour?.usedPercent ?? null}
            resetsAt={codex?.fiveHour?.resetsAt ?? null}
            unavailableLabel={codexUnavailableLabel}
            nowMs={nowMs}
            tone="codex"
          />
          <UsageRow
            label="Codex weekly"
            usedPercent={codex?.weekly?.usedPercent ?? null}
            resetsAt={codex?.weekly?.resetsAt ?? null}
            unavailableLabel={codexUnavailableLabel}
            nowMs={nowMs}
            tone="codex"
          />
        </div>
      </div>
    </section>
  );
}
