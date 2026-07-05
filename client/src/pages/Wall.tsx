/**
 * @file Wall.tsx
 * @description Read-only TV wall mode (Phase U of PLAN-jarvis-v2.md). A
 *   chrome-free `/wall` route (no sidebar/nav, rendered outside Layout) with
 *   big-type instruments for a shared screen: clock, working/waiting agents,
 *   active sessions, 5h-window % + live reset countdown, the needs-you strip,
 *   and an auto-cycling secondary panel (activity ticker / GitHub reds -
 *   pick with `?panels=ops,github`).
 *
 *   READ-ONLY BY CONTRACT: this page may be on a screen anyone can touch, so
 *   it renders zero mutating affordances - no buttons, no links, no inputs
 *   (the needs-you strip is rendered with its `readonly` flag). WS-live via
 *   the app-level event bus (which owns reconnect discipline), with a slow
 *   poll as the degraded fallback. Requests a screen wake lock where the
 *   browser supports it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { NeedsYouStrip } from "../components/NeedsYouStrip";
import { HudWordmark } from "../components/HudWordmark";
import type { Stats, DashboardEvent, GitHubOverview, WSMessage } from "../lib/types";

const POLL_MS = 30000;
const CYCLE_MS = 15000;
const VALID_PANELS = ["ops", "github"] as const;
type PanelKind = (typeof VALID_PANELS)[number];

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Keep the screen awake where supported (TV/spare-monitor use). */
function useWakeLock() {
  useEffect(() => {
    type WakeLockSentinel = { release: () => Promise<void> };
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    };
    const acquire = async () => {
      try {
        if (!nav.wakeLock || document.visibilityState !== "visible") return;
        sentinel = await nav.wakeLock.request("screen");
        if (cancelled) await sentinel.release();
      } catch {
        /* unsupported or denied - the docs cover OS-level wake settings */
      }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      sentinel?.release().catch(() => {});
    };
  }, []);
}

function BigStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="holo-panel hud-frame p-6 text-center">
      <div className={`text-5xl xl:text-7xl font-bold font-mono ${tone || "text-gray-100"}`}>
        {value}
      </div>
      <div className="hud-label text-sm mt-2 text-gray-400">{label}</div>
    </div>
  );
}

export function Wall() {
  const { t } = useTranslation("dashboard");
  const [searchParams] = useSearchParams();
  const now = useClock();
  useWakeLock();

  const panels = useMemo<PanelKind[]>(() => {
    const raw = (searchParams.get("panels") || "ops,github")
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is PanelKind => (VALID_PANELS as readonly string[]).includes(p));
    return raw.length ? [...new Set(raw)] : ["ops"];
  }, [searchParams]);

  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [github, setGithub] = useState<GitHubOverview | null>(null);
  const [panelIdx, setPanelIdx] = useState(0);

  const load = useCallback(async () => {
    try {
      const statsRes = await api.stats.get();
      setStats(statsRes);
    } catch {
      /* keep last good reading - wall must never crash on a blip */
    }
    try {
      const eventsRes = await api.events.list({ limit: 10 });
      setEvents(eventsRes.events);
    } catch {
      /* ignore */
    }
    if (panels.includes("github")) {
      try {
        const gh = await api.github.overview();
        setGithub(gh.overview?.configured ? gh.overview : null);
      } catch {
        /* ignore */
      }
    }
  }, [panels]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // WS-live: new events append instantly; agent/session churn refreshes stats.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "new_event") {
        const ev = msg.data as DashboardEvent;
        setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [ev, ...prev.slice(0, 9)]));
      } else if (
        msg.type === "agent_created" ||
        msg.type === "agent_updated" ||
        msg.type === "session_updated"
      ) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, 500);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  // Auto-cycle the secondary panel when more than one is configured.
  useEffect(() => {
    if (panels.length < 2) return;
    const id = setInterval(() => setPanelIdx((i) => (i + 1) % panels.length), CYCLE_MS);
    return () => clearInterval(id);
  }, [panels]);

  const working = stats?.agents_by_status?.working ?? 0;
  const waiting = stats?.agents_by_status?.waiting ?? 0;

  // Live countdown anchored to the absolute reset timestamp (never a frozen
  // "in 3 hours" - the Phase P rule).
  const windowLabel = useMemo(() => {
    const resetsAt = stats?.session_window?.resetsAt;
    if (!resetsAt) return "--:--";
    const ms = new Date(resetsAt).getTime() - now.getTime();
    if (ms <= 0) return "0:00";
    const totalMin = Math.floor(ms / 60000);
    return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
  }, [stats, now]);

  const percentUsed = stats?.session_window?.percentUsed;
  const activePanel = panels[panelIdx % panels.length];

  return (
    <div className="min-h-screen bg-surface-0 p-6 xl:p-10 flex flex-col gap-6 select-none">
      <header className="flex items-center justify-between">
        <HudWordmark collapsed={false} />
        <div className="text-right">
          <div className="text-5xl xl:text-6xl font-mono font-bold text-gray-100">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
          <div className="text-sm text-gray-500">
            {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            <span className="ml-2 uppercase tracking-wider text-gray-600">
              · {t("wall.readonly")}
            </span>
          </div>
        </div>
      </header>

      <NeedsYouStrip readonly />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 xl:gap-6">
        <BigStat label={t("wall.workingAgents")} value={String(working)} tone="text-accent" />
        <BigStat
          label={t("wall.waitingAgents")}
          value={String(waiting)}
          tone={waiting > 0 ? "text-amber-400" : "text-gray-100"}
        />
        <BigStat label={t("wall.activeSessions")} value={String(stats?.active_sessions ?? 0)} />
        <BigStat
          label={
            percentUsed != null
              ? `${percentUsed}% ${t("wall.windowUsed")} · ${t("wall.windowResets")}`
              : t("wall.windowResets")
          }
          value={windowLabel}
          tone={percentUsed != null && percentUsed >= 80 ? "text-red-400" : "text-gray-100"}
        />
      </div>

      <div className="flex-1 min-h-0">
        {activePanel === "github" && github ? (
          <div className="holo-panel hud-frame p-6 h-full">
            <h2 className="hud-label text-sm text-gray-400 mb-6">{t("wall.githubTitle")}</h2>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
              <BigStat
                label={t("wall.reviewRequested")}
                value={String(github.counts.reviewRequested)}
                tone={github.counts.reviewRequested > 0 ? "text-amber-400" : "text-gray-100"}
              />
              <BigStat
                label={t("wall.failingChecks")}
                value={String(github.counts.failingChecks)}
                tone={github.counts.failingChecks > 0 ? "text-red-400" : "text-gray-100"}
              />
              <BigStat label={t("wall.myPrs")} value={String(github.counts.mine)} />
              <BigStat label={t("wall.openIssues")} value={String(github.counts.openIssues)} />
            </div>
          </div>
        ) : (
          <div className="holo-panel hud-frame p-6 h-full overflow-hidden">
            <h2 className="hud-label text-sm text-gray-400 mb-4">{t("wall.activityTitle")}</h2>
            <ul className="space-y-3">
              {events.length === 0 && <li className="text-gray-600 text-xl">{t("noActivity")}</li>}
              {events.map((e) => (
                <li key={e.id} className="flex items-baseline gap-4 text-xl xl:text-2xl">
                  <span className="font-mono text-gray-600 text-base flex-shrink-0">
                    {new Date(e.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-accent font-medium flex-shrink-0">{e.event_type}</span>
                  <span className="text-gray-300 truncate">{e.summary || e.tool_name || ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
