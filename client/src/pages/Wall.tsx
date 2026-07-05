/**
 * @file Wall.tsx
 * @description Read-only TV wall mode (Phase U of PLAN-jarvis-v2.md) - a
 *   cinematic holographic bridge, aesthetics first. The JarvisCore hologram
 *   (same instrument as the Dashboard) sits center stage, flanked by two
 *   free-floating instruments with no panel chrome, just a soft radial glow:
 *   a spinning active-agents cluster and the vault "brain" - the knowledge
 *   graph as a slowly rotating multi-colored constellation whose links draw
 *   themselves in and fade like synapses firing. Below, an auto-cycling
 *   secondary band (activity ticker / GitHub ring gauges - pick with
 *   `?panels=ops,github`) on a barely-there diffused pane.
 *
 *   HUD personality is fully wired like the main app: `hudMode.init()`, the
 *   typed incantations (type "ultron" to pin ULTRON, "jarvis" to snooze it),
 *   the ?hud= deep link, live error-storm/swarm triggers off the WS feed,
 *   and the UltronTakeover glitch overlay on every flip.
 *
 *   READ-ONLY BY CONTRACT: this page may be on a screen anyone can touch, so
 *   it renders zero mutating affordances - no buttons, no links, no inputs
 *   (the needs-you strip is rendered with its `readonly` flag; the tap-to-
 *   fullscreen toggle and incantations change viewing chrome, not data).
 *   WS-live via the app-level event bus (which owns reconnect discipline),
 *   with a slow poll as the degraded fallback. Requests a screen wake lock
 *   where the browser supports it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { hudMode, installIncantationListener } from "../lib/hudMode";
import { chartColorBright } from "../lib/hudPalette";
import { NeedsYouStrip } from "../components/NeedsYouStrip";
import { HudWordmark } from "../components/HudWordmark";
import { JarvisCore } from "../components/JarvisCore";
import { UltronTakeover } from "../components/UltronTakeover";
import type {
  Agent,
  Session,
  Stats,
  DashboardEvent,
  GitHubOverview,
  VaultGraph,
  WSMessage,
} from "../lib/types";

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

/**
 * Fullscreen state + toggle. Browsers only grant fullscreen from a user
 * gesture, so the wall can't force it on load - instead any tap/click on the
 * page toggles it (viewing chrome, not a mutating affordance, so the
 * read-only contract holds). Kiosk/TV setups that launch the browser with
 * `--kiosk`/`--start-fullscreen` never need the tap.
 */
function useFullscreen(): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);
  return [fullscreen, toggle];
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

/** Deterministic small hash so vault nodes keep their spot between polls. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Ring gauge for the GitHub band - a big mono number inside a slowly
 * rotating tick ring with a partial accent arc. No box, floats free.
 */
function RingStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const color = tone || "rgb(var(--hud-accent))";
  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox="0 0 120 120" className="w-24 xl:w-32 overflow-visible">
        <g className="holo-orbit-spin">
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke={color}
            strokeOpacity="0.4"
            strokeWidth="2"
            strokeDasharray="3 9"
          />
        </g>
        <circle cx="60" cy="60" r="44" fill="none" stroke="rgb(var(--hud-accent) / 0.12)" />
        <circle
          cx="60"
          cy="60"
          r="44"
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(value > 0 ? 0.72 : 0.08) * 2 * Math.PI * 44} ${2 * Math.PI * 44}`}
          transform="rotate(-90 60 60)"
          opacity={value > 0 ? 0.9 : 0.35}
        />
        <text
          x="60"
          y="62"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={value > 0 ? color : "#e5e7eb"}
          fontSize="34"
          fontWeight="700"
          fontFamily="monospace"
        >
          {value}
        </text>
      </svg>
      <span className="hud-label text-xs text-gray-400">{label}</span>
    </div>
  );
}

/**
 * The active-agents cluster - free-floating over a radial glow, no panel:
 * counter-rotating tick rings around a ring of agent dots (working = emerald
 * pulse, waiting = amber pulse) and a big live count.
 */
function AgentCluster({ working, waiting }: { working: number; waiting: number }) {
  const { t } = useTranslation("dashboard");
  const total = working + waiting;
  const MAX_DOTS = 12;
  const shown = Math.min(total, MAX_DOTS);
  const workingDots =
    total > 0 ? Math.max(working > 0 ? 1 : 0, Math.round((shown * working) / total)) : 0;
  const waitingDots = Math.max(0, shown - workingDots);

  const dot = (i: number) => {
    const angle = ((360 / Math.max(shown, 1)) * i - 90) * (Math.PI / 180);
    return { x: 110 + 82 * Math.cos(angle), y: 110 + 82 * Math.sin(angle) };
  };

  return (
    <div className="flex flex-col items-center gap-1 mx-auto">
      <div className="wall-glow rounded-full">
        <svg viewBox="0 0 220 220" className="w-64 xl:w-80 max-w-full overflow-visible">
          <g className="holo-orbit-spin">
            <circle
              cx="110"
              cy="110"
              r="100"
              fill="none"
              stroke="rgb(var(--hud-accent) / 0.3)"
              strokeWidth="1.5"
              strokeDasharray="2 10"
            />
          </g>
          <g className="holo-orbit-spin" style={{ animationDirection: "reverse" }}>
            <circle
              cx="110"
              cy="110"
              r="92"
              fill="none"
              stroke="rgb(var(--hud-accent) / 0.15)"
              strokeWidth="1"
              strokeDasharray="40 18 12 24"
            />
          </g>
          <circle cx="110" cy="110" r="82" fill="none" stroke="rgb(var(--hud-accent) / 0.12)" />
          <g className="holo-orbit-spin">
            {Array.from({ length: workingDots }, (_, i) => {
              const { x, y } = dot(i);
              return (
                <circle
                  key={`w${i}`}
                  cx={x}
                  cy={y}
                  r="6"
                  fill="#34d399"
                  className="animate-pulse-dot vault-node"
                  style={{ color: "#34d399" }}
                />
              );
            })}
            {Array.from({ length: waitingDots }, (_, i) => {
              const { x, y } = dot(workingDots + i);
              return (
                <circle
                  key={`x${i}`}
                  cx={x}
                  cy={y}
                  r="6"
                  fill="#fbbf24"
                  className="animate-pulse-dot vault-node"
                  style={{ color: "#fbbf24" }}
                />
              );
            })}
          </g>
          <text
            x="110"
            y="112"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-gray-100"
            fontSize="48"
            fontWeight="700"
            fontFamily="monospace"
          >
            {total}
          </text>
        </svg>
      </div>
      <div className="hud-label text-sm text-gray-500">{t("wall.agentsTitle")}</div>
      <div className="flex gap-6 font-mono text-base xl:text-lg">
        <span className="text-emerald-400">
          {working} {t("wall.workingAgents").toLowerCase()}
        </span>
        <span className={waiting > 0 ? "text-amber-400" : "text-gray-600"}>
          {waiting} {t("wall.waitingAgents").toLowerCase()}
        </span>
      </div>
    </div>
  );
}

/**
 * The vault brain - the knowledge graph as a living hologram, no panel.
 * Nodes get a deterministic polar position and size from their id hash
 * (stable across polls) and a color from the validated chart palette keyed
 * by node type (person/project/area/... each get their own hue). Links
 * carry their source node's color and continuously redraw themselves via
 * the .vault-link synapse animation; the whole constellation rotates on a
 * slow spin. Self-hides when the vault is empty or unreachable.
 */
function VaultBrain({ graph }: { graph: VaultGraph | null }) {
  const { t } = useTranslation("dashboard");
  const placed = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const MAX_NODES = 48;
    const types = [...new Set(graph.nodes.map((n) => n.type))].sort();
    const nodes = graph.nodes.slice(0, MAX_NODES).map((n) => {
      const h = hashId(n.id);
      const angle = (h % 360) * (Math.PI / 180);
      const radius = 22 + ((h >> 9) % 72);
      return {
        id: n.id,
        x: 110 + radius * Math.cos(angle),
        y: 110 + radius * Math.sin(angle),
        r: 2.5 + ((h >> 4) % 3),
        delay: (h % 24) / 10,
        color: chartColorBright(types.indexOf(n.type)),
      };
    });
    const pos = new Map(nodes.map((n) => [n.id, n]));
    const edges = graph.edges
      .filter((e) => pos.has(e.src) && pos.has(e.dst))
      .slice(0, 90)
      .map((e) => ({ a: pos.get(e.src)!, b: pos.get(e.dst)! }));
    return { nodes, edges, total: graph.nodes.length };
  }, [graph]);

  if (!placed) return null;

  return (
    <div className="flex flex-col items-center gap-1 mx-auto">
      <div className="wall-glow rounded-full">
        <svg viewBox="0 0 220 220" className="w-64 xl:w-80 max-w-full overflow-visible">
          <circle cx="110" cy="110" r="100" fill="none" stroke="rgb(var(--hud-accent) / 0.08)" />
          <circle cx="110" cy="110" r="44" fill="rgb(var(--hud-accent) / 0.05)" />
          <g className="holo-orbit-spin" style={{ animationDuration: "60s" }}>
            {placed.edges.map((e, i) => (
              <line
                key={i}
                x1={e.a.x}
                y1={e.a.y}
                x2={e.b.x}
                y2={e.b.y}
                pathLength={1}
                stroke={e.a.color}
                strokeWidth="0.8"
                className="vault-link"
                style={
                  {
                    animationDelay: `${(i % 13) * 0.55}s`,
                    "--link-dur": `${6 + (i % 5)}s`,
                  } as React.CSSProperties
                }
              />
            ))}
            {placed.nodes.map((n) => (
              <circle
                key={n.id}
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={n.color}
                className="animate-pulse-dot vault-node"
                style={{ color: n.color, animationDelay: `${n.delay}s` }}
              />
            ))}
          </g>
        </svg>
      </div>
      <div className="hud-label text-sm text-gray-500">{t("wall.vaultTitle")}</div>
      <div className="font-mono text-base xl:text-lg text-accent">
        {placed.total} {t("wall.vaultNotes")}
      </div>
    </div>
  );
}

export function Wall() {
  const { t } = useTranslation("dashboard");
  const [searchParams] = useSearchParams();
  const now = useClock();
  const [fullscreen, toggleFullscreen] = useFullscreen();
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
  const [vault, setVault] = useState<VaultGraph | null>(null);
  const [connected, setConnected] = useState(() => eventBus.connected);
  const [panelIdx, setPanelIdx] = useState(0);

  // HUD personality, wired exactly like Layout does for the main app: init
  // from the persisted setting / ?hud= param, listen for the typed
  // incantations ("ultron" pins, "jarvis" snoozes), and feed live agent/
  // session activity into the automatic ULTRON triggers.
  useEffect(() => {
    hudMode.init();
    const removeKeys = installIncantationListener();
    const unsubscribe = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "agent_created" || msg.type === "agent_updated") {
        const agent = msg.data as Agent;
        if (agent && typeof agent.id === "string" && typeof agent.status === "string") {
          hudMode.reportAgentStatus(agent.id, agent.status);
          if (agent.status === "error") hudMode.reportError();
        }
      } else if (msg.type === "session_updated") {
        const session = msg.data as Session;
        if (session && session.status === "error") hudMode.reportError();
      }
    });
    return () => {
      removeKeys();
      unsubscribe();
    };
  }, []);

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
    try {
      setVault(await api.vault.graph());
    } catch {
      /* vault disabled or unreachable - the brain self-hides */
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

  useEffect(() => eventBus.onConnection(setConnected), []);

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
  const activePanel = panels[panelIdx % panels.length];

  return (
    <div
      className="min-h-screen bg-surface-0 p-6 xl:p-10 flex flex-col gap-6 select-none cursor-default"
      onClick={toggleFullscreen}
    >
      <UltronTakeover />
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
              {!fullscreen && <> · {t("wall.fullscreenHint")}</>}
            </span>
          </div>
        </div>
      </header>

      <NeedsYouStrip readonly />

      {/* The bridge: agents cluster | Jarvis hologram | vault brain, all
          free-floating - no panel chrome, aesthetics first. The core carries
          the live count, session-window countdown ring, and USED % readout. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-6 items-center flex-shrink-0">
        <div className="order-2 xl:order-1">
          <AgentCluster working={working} waiting={waiting} />
        </div>
        <div className="order-1 xl:order-2">
          <JarvisCore
            working={working}
            waiting={waiting}
            connected={connected}
            readout={
              stats
                ? `${stats.active_sessions} ${t("wall.activeSessions").toUpperCase()}`
                : undefined
            }
            sessionWindow={stats?.session_window}
          />
        </div>
        <div className="order-3">
          <VaultBrain graph={vault} />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {activePanel === "github" && github ? (
          <div className="wall-panel p-6 h-full">
            <h2 className="hud-label text-sm text-gray-400 mb-6">{t("wall.githubTitle")}</h2>
            <div className="flex flex-wrap justify-around gap-6">
              <RingStat
                label={t("wall.reviewRequested")}
                value={github.counts.reviewRequested}
                tone={github.counts.reviewRequested > 0 ? "#fbbf24" : undefined}
              />
              <RingStat
                label={t("wall.failingChecks")}
                value={github.counts.failingChecks}
                tone={github.counts.failingChecks > 0 ? "#f87171" : undefined}
              />
              <RingStat label={t("wall.myPrs")} value={github.counts.mine} />
              <RingStat label={t("wall.openIssues")} value={github.counts.openIssues} />
            </div>
          </div>
        ) : (
          <div className="wall-panel p-6 h-full overflow-hidden">
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
