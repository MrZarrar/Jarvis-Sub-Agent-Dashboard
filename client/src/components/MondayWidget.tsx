/**
 * @file MondayWidget.tsx
 * @description Compact Monday.com summary for the home command bridge (Phase
 * AD): "2 overdue · 3 due today · 5 mine" as tappable chips linking to the full
 * Monday page. Self-hides when Monday isn't configured (no token), same posture
 * as GitHubWidget.
 *
 * Read-only summary; live-updates on the `monday_updated` WebSocket event and
 * degrades safely if that event is delayed (it seeds from the cached overview
 * on mount, and the server keeps the cache warm via the poller).
 */

import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { ClipboardList, CalendarClock, CircleAlert, User } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { MondayOverviewResponse, WSMessage } from "../lib/types";

export function MondayWidget() {
  const [data, setData] = useState<MondayOverviewResponse | null>(null);

  const load = useCallback(() => {
    const p = api.monday?.overview?.();
    if (!p) {
      setData(null);
      return;
    }
    p.then(setData).catch(() => setData(null));
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "monday_updated") load();
    });
  }, [load]);

  // Hidden until configured - nothing to show, and no clutter for non-users.
  if (!data || !data.configured) return null;

  const c = data.overview.counts;
  const chips: { icon: typeof ClipboardList; label: string; tone: string }[] = [];
  if (c.overdue > 0)
    chips.push({ icon: CircleAlert, label: `${c.overdue} overdue`, tone: "text-red-400" });
  if (c.dueToday > 0)
    chips.push({ icon: CalendarClock, label: `${c.dueToday} due today`, tone: "text-amber-400" });
  if (c.mine > 0)
    chips.push({
      icon: User,
      label: `${c.mine} assigned to you`,
      tone: "text-gray-300",
    });

  return (
    <NavLink
      to="/monday"
      className="holo-panel hud-frame holo-boot flex items-center gap-3 p-3 hover:border-accent/40 transition-colors"
      style={{ "--boot-delay": "0.64s" } as React.CSSProperties}
    >
      <ClipboardList className="w-4 h-4 flex-shrink-0 text-accent/80" />
      <span className="hud-label">Monday</span>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        {chips.length === 0 ? (
          <span className="text-xs text-gray-500">All clear</span>
        ) : (
          chips.map((chip, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 text-xs font-medium ${chip.tone}`}
            >
              <chip.icon className="w-3.5 h-3.5 flex-shrink-0" />
              {chip.label}
              {i < chips.length - 1 && <span className="text-gray-600 ml-1">·</span>}
            </span>
          ))
        )}
      </div>
      {data.overview.error && (
        <span
          className="ml-auto text-[11px] text-amber-400 truncate max-w-[12rem]"
          title={data.overview.error}
        >
          {data.overview.error}
        </span>
      )}
    </NavLink>
  );
}
