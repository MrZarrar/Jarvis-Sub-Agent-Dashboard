/**
 * @file JarvisCore.tsx
 * @description The central HUD brain — an arc-reactor core of counter-rotating
 *   rings around a breathing nucleus. Activity-reactive: each working agent
 *   spins the rings faster and shortens the pulse (idle ≈3.2s breath → busy
 *   sub-second heartbeat), engagement ripples radiate while work is in
 *   flight, and a sweep arm orbits when the system is engaged.
 *
 *   The core changes SHAPE with the HUD personality, not just color:
 *   JARVIS is all soft circles; ULTRON swaps in a hexagonal nucleus plate
 *   with a counter-rotating targeting triangle, a blocky teeth ring, and a
 *   second sweep arm — the reactor becomes a weapon sight.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { hudMode, type HudMode } from "../lib/hudMode";

interface JarvisCoreProps {
  /** Agents (mains + subagents) currently in "working" status. */
  working: number;
  /** Agents currently in "waiting" status. */
  waiting: number;
  connected: boolean;
  /** Optional readout under the status line (e.g. events/min). */
  readout?: string;
}

const ACCENT = "rgb(var(--hud-accent))";

function a(alpha: number): string {
  return `rgb(var(--hud-accent) / ${alpha})`;
}

/** Regular polygon points around (220,220). */
function polygonPoints(radius: number, sides: number, rotationDeg = 0): string {
  return Array.from({ length: sides }, (_, i) => {
    const angle = ((360 / sides) * i + rotationDeg) * (Math.PI / 180);
    return `${(220 + radius * Math.cos(angle)).toFixed(1)},${(220 + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}

export function JarvisCore({ working, waiting, connected, readout }: JarvisCoreProps) {
  const { t } = useTranslation("dashboard");
  const [mode, setMode] = useState<HudMode>(hudMode.getMode());

  useEffect(() => {
    setMode(hudMode.getMode());
    return hudMode.subscribe((change) => setMode(change.mode));
  }, []);

  const ultron = mode === "ultron";
  const engaged = connected && working > 0;
  // Ring velocity and pulse period scale with load, saturating at 8 agents.
  // ULTRON idles hotter and hits harder.
  const speed = (engaged ? 1 + Math.min(working, 8) * 0.5 : 1) * (ultron ? 1.6 : 1);
  const pulse = engaged ? Math.max(0.9, 3.2 / (1 + working * 0.5)) : ultron ? 2.2 : 3.2;

  const status = !connected
    ? t("core.offline", "UPLINK OFFLINE")
    : engaged
      ? ultron
        ? t("core.engagedUltron", "DRONES DEPLOYED")
        : t("core.engaged", "AGENTS ENGAGED")
      : waiting > 0
        ? t("core.awaiting", "AWAITING INPUT")
        : ultron
          ? t("core.nominalUltron", "WATCHING. WAITING.")
          : t("core.nominal", "ALL SYSTEMS NOMINAL");

  return (
    <div
      className="relative w-[26rem] h-[26rem] max-w-full mx-auto select-none"
      style={
        {
          "--core-speed": speed,
          "--core-pulse": `${pulse}s`,
        } as React.CSSProperties
      }
      role="img"
      aria-label={`${status}${engaged ? ` — ${working}` : ""}`}
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

        {/* Outer tick ring — slow, counter-clockwise */}
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

        {/* Middle segment ring — medium, clockwise */}
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

        {/* ULTRON teeth — blocky saw ring grinding against the middle ring */}
        {ultron && (
          <g className="core-ring core-ring-inner">
            <circle
              cx="220"
              cy="220"
              r="150"
              fill="none"
              stroke={a(0.4)}
              strokeWidth="12"
              strokeDasharray="4 17"
            />
          </g>
        )}

        {/* Inner tick ring — fast, counter-clockwise */}
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

        {/* Sweep arms — one benign arm for JARVIS, twin scythes for ULTRON */}
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

        {/* Nucleus — soft orb for JARVIS, hex plate + targeting triangle for ULTRON */}
        {ultron ? (
          <>
            <g className="core-nucleus">
              <polygon
                points={polygonPoints(100, 6, -90)}
                fill="url(#core-nucleus-fill)"
                stroke={a(0.7)}
                strokeWidth="2"
              />
              <polygon
                points={polygonPoints(84, 6, -90)}
                fill="none"
                stroke={a(0.3)}
                strokeWidth="1"
                strokeDasharray="6 5"
              />
            </g>
            <g className="core-ring core-ring-inner">
              <polygon
                points={polygonPoints(62, 3, -90)}
                fill="none"
                stroke={a(0.5)}
                strokeWidth="1.5"
              />
            </g>
          </>
        ) : (
          <g className="core-nucleus">
            <circle
              cx="220"
              cy="220"
              r="96"
              fill="url(#core-nucleus-fill)"
              stroke={a(0.55)}
              strokeWidth="1.5"
            />
            <circle
              cx="220"
              cy="220"
              r="72"
              fill="none"
              stroke={a(0.3)}
              strokeWidth="1"
              strokeDasharray="4 6"
            />
          </g>
        )}
      </svg>

      {/* Center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <span
          className={`font-mono font-bold leading-none text-glow ${
            engaged ? "text-6xl text-accent" : "text-5xl text-accent/70"
          }`}
        >
          {connected ? working : "—"}
        </span>
        <span className="hud-label mt-3">{status}</span>
        {readout && (
          <span className="mt-1 text-[10px] font-mono text-gray-500 tracking-wider">{readout}</span>
        )}
      </div>
    </div>
  );
}
