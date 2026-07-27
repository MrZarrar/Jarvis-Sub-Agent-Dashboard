/**
 * @file JarvisCore.tsx
 * @description The central HUD brain - an arc-reactor core of counter-rotating
 *   rings around a breathing nucleus. Activity-reactive: each working agent
 *   spins the rings faster and shortens the pulse (idle ≈3.2s breath → busy
 *   sub-second heartbeat), engagement ripples radiate while work is in
 *   flight, and a sweep arm orbits when the system is engaged.
 *
 *   The core changes SHAPE with the HUD personality, not just color:
 *   JARVIS is all soft circles; ULTRON swaps in a hexagonal nucleus plate
 *   with a counter-rotating targeting triangle, a blocky teeth ring, and a
 *   second sweep arm - the reactor becomes a weapon sight.
 *
 *   A depleting arc at the outermost edge doubles as the session-usage
 *   countdown clock ("the core IS the clock") when an active usage window
 *   is passed in - it ticks its own digits every second, independent of
 *   whatever cadence the parent polls stats at.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { hudMode, type HudMode } from "../lib/hudMode";
import { CoreSphere3D } from "./CoreSphere3D";
import type { CodexUsage } from "../lib/types";

interface JarvisCoreProps {
  /** Engagement count shown in the nucleus. */
  working: number;
  waiting: number;
  connected: boolean;
  engagedLabel?: string;
  /** Live subscription limit windows from Codex app-server. */
  codexUsage?: CodexUsage | null;
}

const ACCENT = "rgb(var(--hud-accent))";

function a(alpha: number): string {
  return `rgb(var(--hud-accent) / ${alpha})`;
}

function minutesLeft(resetsAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - nowMs) / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m left`;
  }
  return `${minutes}min${minutes === 1 ? "" : "s"} left`;
}

/** Regular polygon points around (220,220). */
function polygonPoints(radius: number, sides: number, rotationDeg = 0): string {
  return Array.from({ length: sides }, (_, i) => {
    const angle = ((360 / sides) * i + rotationDeg) * (Math.PI / 180);
    return `${(220 + radius * Math.cos(angle)).toFixed(1)},${(220 + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}

export function JarvisCore({
  working,
  waiting,
  connected,
  engagedLabel,
  codexUsage,
}: JarvisCoreProps) {
  const { t } = useTranslation("dashboard");
  const [mode, setMode] = useState<HudMode>(hudMode.getMode());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setMode(hudMode.getMode());
    return hudMode.subscribe((change) => setMode(change.mode));
  }, []);

  const resetsAt = codexUsage?.fiveHour?.resetsAt;
  useEffect(() => {
    if (!resetsAt) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resetsAt]);

  const fiveHour = codexUsage?.fiveHour ?? null;
  const weekly = codexUsage?.weekly ?? null;
  const weeklyReset = weekly?.resetsAt
    ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(weekly.resetsAt))
    : "N/A";
  const usageAria = `GPT five-hour ${
    fiveHour ? `${Math.round(fiveHour.remainingPercent)}% remaining` : "N/A"
  }, weekly ${weekly ? `${Math.round(weekly.remainingPercent)}% remaining` : "N/A"}`;

  const ultron = mode === "ultron";
  const engaged = connected && working > 0;
  // Ring velocity and pulse period scale with load, saturating at 8 items.
  // ULTRON idles hotter and hits harder.
  const speed = (engaged ? 1 + Math.min(working, 8) * 0.5 : 1) * (ultron ? 1.6 : 1);
  const pulse = engaged ? Math.max(0.9, 3.2 / (1 + working * 0.5)) : ultron ? 2.2 : 3.2;

  // GPT five-hour reset clock, drawn as a depleting arc around the whole core.
  let countdownFrac = 0;
  let countdownColor = ACCENT;
  if (resetsAt) {
    const resetsAtMs = Date.parse(resetsAt);
    const startedAtMs = resetsAtMs - 5 * 60 * 60 * 1000;
    const totalMs = Math.max(1, resetsAtMs - startedAtMs);
    const remainingMs = Math.max(0, resetsAtMs - nowMs);
    countdownFrac = Math.max(0, Math.min(1, remainingMs / totalMs));
    countdownColor =
      remainingMs < 5 * 60 * 1000 ? "#f87171" : remainingMs < 30 * 60 * 1000 ? "#fbbf24" : ACCENT;
  }

  const status = !connected
    ? t("core.offline", "UPLINK OFFLINE")
    : engaged
      ? ultron
        ? t("core.engagedUltron", "DRONES DEPLOYED")
        : (engagedLabel ?? t("core.engaged", "AGENTS ENGAGED"))
      : waiting > 0
        ? t("core.awaiting", "AWAITING INPUT")
        : ultron
          ? t("core.nominalUltron", "WATCHING. WAITING.")
          : t("core.nominal", "ALL SYSTEMS NOMINAL");

  return (
    <div
      className="relative aspect-square w-[32rem] max-w-full mx-auto select-none"
      style={
        {
          "--core-speed": speed,
          "--core-pulse": `${pulse}s`,
        } as React.CSSProperties
      }
      role="img"
      aria-label={`${status}${engaged ? ` - ${working}` : ""}. ${usageAria}`}
    >
      <svg viewBox="0 0 440 440" className="w-full h-full">
        <defs>
          <radialGradient id="core-nucleus-fill" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stopColor={a(0.55)} />
            <stop offset="45%" stopColor={a(0.22)} />
            <stop offset="100%" stopColor={a(0.05)} />
          </radialGradient>
          <linearGradient id="core-sweep-fill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={a(0)} />
            <stop offset="100%" stopColor={a(0.4)} />
          </linearGradient>
        </defs>

        {/* GPT five-hour reset countdown. */}
        {resetsAt && (
          <>
            <circle cx="220" cy="220" r="214" fill="none" stroke={a(0.08)} strokeWidth="4" />
            <circle
              className="core-countdown-ring"
              cx="220"
              cy="220"
              r="214"
              fill="none"
              stroke={countdownColor}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${countdownFrac * 2 * Math.PI * 214} ${2 * Math.PI * 214}`}
              transform="rotate(-90 220 220)"
            />
          </>
        )}

        {/* Static halo */}
        {ultron ? (
          <polygon
            points={polygonPoints(212, 6, -90)}
            fill="none"
            stroke={a(0.14)}
            strokeWidth="1.5"
          />
        ) : (
          <circle cx="220" cy="220" r="212" fill="none" stroke={a(0.1)} strokeWidth="1" />
        )}

        {/* Outer tick ring - slow, counter-clockwise */}
        <g className="core-ring core-ring-outer">
          <circle
            cx="220"
            cy="220"
            r="198"
            fill="none"
            stroke={a(0.45)}
            strokeWidth={ultron ? 5 : 3}
            strokeDasharray={ultron ? "14 22" : "2 11"}
          />
          <circle
            cx="220"
            cy="220"
            r="188"
            fill="none"
            stroke={a(0.2)}
            strokeWidth="1"
            strokeDasharray="60 18 24 30"
          />
        </g>

        {/* Middle segment ring - medium, clockwise */}
        <g className="core-ring core-ring-middle">
          <circle
            cx="220"
            cy="220"
            r="164"
            fill="none"
            stroke={a(0.5)}
            strokeWidth="2"
            strokeDasharray={ultron ? "40 14 8 14 40 14 8 14" : "90 26 34 26 60 26"}
            strokeLinecap={ultron ? "butt" : "round"}
          />
          <circle cx="220" cy="384" r="4" fill={ACCENT} />
        </g>

        {/* Blocky segmented band - subtle plating for JARVIS, grinding saw
            teeth for ULTRON (the reference image's chunky mid ring) */}
        <g className="core-ring core-ring-inner">
          <circle
            cx="220"
            cy="220"
            r="150"
            fill="none"
            stroke={a(ultron ? 0.4 : 0.16)}
            strokeWidth="12"
            strokeDasharray={ultron ? "4 17" : "7 6"}
          />
        </g>

        {/* Inner tick ring - fast, counter-clockwise */}
        <g className="core-ring core-ring-inner">
          <circle
            cx="220"
            cy="220"
            r="134"
            fill="none"
            stroke={a(0.35)}
            strokeWidth="6"
            strokeDasharray={ultron ? "10 9" : "1.5 7"}
          />
          <circle
            cx="220"
            cy="220"
            r="122"
            fill="none"
            stroke={a(0.6)}
            strokeWidth="1.5"
            strokeDasharray="46 150 46 150"
            strokeLinecap={ultron ? "butt" : "round"}
          />
        </g>

        {/* Sweep arms - one benign arm for JARVIS, twin scythes for ULTRON */}
        {engaged && (
          <g className="core-sweep">
            <path
              d="M 220 220 L 220 76 A 144 144 0 0 1 292 96 Z"
              fill="url(#core-sweep-fill)"
              opacity="0.55"
            />
            <line x1="220" y1="220" x2="220" y2="76" stroke={a(0.7)} strokeWidth="1.5" />
            {ultron && (
              <>
                <path
                  d="M 220 220 L 220 364 A 144 144 0 0 1 148 344 Z"
                  fill="url(#core-sweep-fill)"
                  opacity="0.55"
                />
                <line x1="220" y1="220" x2="220" y2="364" stroke={a(0.7)} strokeWidth="1.5" />
              </>
            )}
          </g>
        )}

        {/* Engagement ripples */}
        {engaged && (
          <>
            <circle
              className="core-ripple"
              cx="220"
              cy="220"
              r="150"
              fill="none"
              stroke={a(0.5)}
              strokeWidth="1.5"
            />
            <circle
              className="core-ripple"
              cx="220"
              cy="220"
              r="150"
              fill="none"
              stroke={a(0.35)}
              strokeWidth="1"
              style={{ animationDelay: `calc(var(--core-pulse) * 0.7)` }}
            />
          </>
        )}

        {/* Faint nucleus backing glow - pulses with load behind the 3D sphere */}
        <circle
          className="core-nucleus"
          cx="220"
          cy="220"
          r="96"
          fill="url(#core-nucleus-fill)"
          opacity="0.55"
        />
        {ultron && (
          <g className="core-ring core-ring-inner">
            <polygon
              points={polygonPoints(62, 3, -90)}
              fill="none"
              stroke={a(0.35)}
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>

      {/* The living nucleus - cursor-tracking geodesic hologram (Three.js) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative w-[82%] h-[82%]">
          <CoreSphere3D working={working} connected={connected} />
        </div>
      </div>

      {/* Center readout - a glass HUD lens floating IN FRONT of the sphere,
          with a defined rim so text never fights the wireframe behind it */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className="relative flex h-60 w-60 flex-col items-center justify-center rounded-full text-center"
          style={{
            background:
              "radial-gradient(circle, rgba(2,6,9,0.94) 0%, rgba(2,6,9,0.85) 55%, rgba(2,6,9,0.3) 80%, transparent 100%)",
            backdropFilter: "blur(3px)",
            boxShadow: "inset 0 0 26px rgb(var(--hud-accent) / 0.12), 0 0 46px rgba(2,6,9,0.9)",
          }}
        >
          <span
            className="absolute inset-0 rounded-full border"
            style={{ borderColor: "rgb(var(--hud-accent) / 0.4)" }}
            aria-hidden
          />
          <span
            className="absolute inset-2 rounded-full border border-dashed"
            style={{ borderColor: "rgb(var(--hud-accent) / 0.15)" }}
            aria-hidden
          />
          <span
            className={`font-mono font-bold leading-none ${
              engaged ? "text-7xl text-accent" : "text-6xl text-accent/80"
            }`}
            style={{ textShadow: "0 0 22px rgb(var(--hud-accent) / 0.75)" }}
          >
            {connected ? working : "-"}
          </span>
          <span className="hud-label mt-3" style={{ color: "rgb(var(--hud-accent) / 0.95)" }}>
            {status}
          </span>
          <div className="mt-3 w-48 font-mono">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-accent/50" />
              <span className="text-[13px] font-bold tracking-[0.22em] text-accent">GPT</span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-accent/50" />
            </div>

            <div className="space-y-2 text-[11px]">
              <div>
                <div className="flex items-center justify-between">
                  <span className="tracking-widest text-gray-400">5 HOUR</span>
                  <span className="text-[13px] font-bold text-gray-200">
                    {fiveHour ? `${Math.round(fiveHour.remainingPercent)}%` : "N/A"}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full border border-accent/20 bg-accent/5">
                  {fiveHour ? (
                    <div
                      className="h-full rounded-full bg-accent shadow-[0_0_8px_rgb(var(--hud-accent)/0.7)]"
                      style={{ width: `${Math.max(0, Math.min(100, fiveHour.remainingPercent))}%` }}
                    />
                  ) : (
                    <div
                      className="h-full opacity-40"
                      style={{
                        backgroundImage:
                          "repeating-linear-gradient(135deg, transparent 0 4px, rgb(var(--hud-accent) / 0.45) 4px 5px)",
                      }}
                    />
                  )}
                </div>
                {fiveHour?.resetsAt && (
                  <div className="mt-1 text-right text-[9px] tracking-wider text-gray-500">
                    RESET {minutesLeft(fiveHour.resetsAt, nowMs).toUpperCase()}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className="tracking-widest text-gray-400">WEEKLY</span>
                  <span className="text-[13px] font-bold text-gray-200">
                    {weekly ? `${Math.round(weekly.remainingPercent)}%` : "N/A"}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full border border-accent/20 bg-accent/5">
                  <div
                    className="h-full rounded-full bg-accent shadow-[0_0_8px_rgb(var(--hud-accent)/0.7)]"
                    style={{
                      width: `${Math.max(0, Math.min(100, weekly?.remainingPercent ?? 0))}%`,
                    }}
                  />
                </div>
                <div className="mt-1 text-right text-[9px] tracking-wider text-gray-500">
                  RESET {weeklyReset.toUpperCase()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
