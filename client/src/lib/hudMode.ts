/**
 * @file hudMode.ts
 * @description HUD personality manager - JARVIS (cyan) vs ULTRON (crimson).
 *
 * The effective mode is decided from three layers (highest priority first):
 *   1. Manual override ("jarvis" | "ultron"), persisted in localStorage.
 *      Set from the Settings toggle. Pins the mode until changed again —
 *      auto-triggers are never even consulted.
 *   2. A temporary "dismiss" window (only while manual === "auto"): typing
 *      the "jarvis" incantation calms the HUD immediately without pinning
 *      anything. It's a snooze, not an override — once the window elapses,
 *      auto-triggers resume normally and can flip back to ULTRON if the
 *      underlying condition (error storm, swarm) is still active.
 *   3. Automatic triggers (only in "auto", once the dismiss window elapses):
 *      - Error storm: 3+ agent/session errors inside 60s → ULTRON until the
 *        60s window clears.
 *      - Swarm: 5+ concurrently active agents → ULTRON while the swarm holds.
 *      - Kill flash: killing a run → ULTRON for 10s ("no strings on me").
 *
 * Mode is applied as `data-theme` on <html>; all theme colors are CSS
 * variables, so the swap is instant and app-wide. Every change also emits a
 * window CustomEvent("hud:modechange") so the takeover overlay can play the
 * glitch transition.
 */

export type HudMode = "jarvis" | "ultron";
export type HudModeSetting = HudMode | "auto";

export interface HudModeChange {
  mode: HudMode;
  reason: string;
}

const MANUAL_KEY = "hud-mode-manual";
const ERROR_WINDOW_MS = 60_000;
const ERROR_STORM_THRESHOLD = 3;
const SWARM_THRESHOLD = 5;
const KILL_FLASH_MS = 10_000;
const DISMISS_MS = 15_000;

type Listener = (change: HudModeChange) => void;

const listeners = new Set<Listener>();
const errorTimestamps: number[] = [];
/** agent id → active? (working/waiting) */
const activeAgents = new Map<string, boolean>();
let killFlashUntil = 0;
/** Temporary snooze from the "jarvis" incantation — expires back into auto. */
let dismissUntil = 0;
let revertTimer: ReturnType<typeof setTimeout> | null = null;
let currentMode: HudMode = "jarvis";

function readManual(): HudModeSetting {
  try {
    const v = localStorage.getItem(MANUAL_KEY);
    return v === "jarvis" || v === "ultron" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

function writeManual(setting: HudModeSetting) {
  try {
    localStorage.setItem(MANUAL_KEY, setting);
  } catch {
    /* best-effort */
  }
}

function now() {
  return Date.now();
}

function pruneErrors() {
  const cutoff = now() - ERROR_WINDOW_MS;
  while (errorTimestamps.length > 0 && (errorTimestamps[0] as number) < cutoff) {
    errorTimestamps.shift();
  }
}

function activeAgentCount(): number {
  let n = 0;
  for (const active of activeAgents.values()) if (active) n += 1;
  return n;
}

function triggerReason(): string | null {
  pruneErrors();
  if (errorTimestamps.length >= ERROR_STORM_THRESHOLD) return "error-storm";
  if (activeAgentCount() >= SWARM_THRESHOLD) return "swarm";
  if (now() < killFlashUntil) return "kill-flash";
  return null;
}

function computeMode(): HudModeChange {
  const manual = readManual();
  if (manual === "jarvis" || manual === "ultron") return { mode: manual, reason: "manual" };
  if (now() < dismissUntil) return { mode: "jarvis", reason: "dismissed" };
  const trigger = triggerReason();
  return trigger ? { mode: "ultron", reason: trigger } : { mode: "jarvis", reason: "calm" };
}

/** Schedule a re-evaluation when the earliest transient trigger expires. */
function scheduleRevert() {
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  const candidates: number[] = [];
  if (errorTimestamps.length >= ERROR_STORM_THRESHOLD) {
    candidates.push((errorTimestamps[0] as number) + ERROR_WINDOW_MS - now());
  }
  if (now() < killFlashUntil) candidates.push(killFlashUntil - now());
  if (now() < dismissUntil) candidates.push(dismissUntil - now());
  if (candidates.length === 0) return;
  const delay = Math.max(250, Math.min(...candidates) + 50);
  revertTimer = setTimeout(() => {
    revertTimer = null;
    evaluate();
  }, delay);
}

function apply(change: HudModeChange) {
  if (change.mode === currentMode) return;
  currentMode = change.mode;
  try {
    document.documentElement.dataset.theme = change.mode;
    window.dispatchEvent(new CustomEvent<HudModeChange>("hud:modechange", { detail: change }));
  } catch {
    /* non-DOM context */
  }
  for (const cb of listeners) cb(change);
}

function evaluate() {
  apply(computeMode());
  scheduleRevert();
}

export const hudMode = {
  /** Current effective mode. */
  getMode(): HudMode {
    return currentMode;
  },

  /** The persisted manual setting ("auto" defers to triggers). */
  getSetting(): HudModeSetting {
    return readManual();
  },

  setSetting(setting: HudModeSetting) {
    writeManual(setting);
    evaluate();
  },

  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Record an agent/session error (error-storm trigger). */
  reportError() {
    errorTimestamps.push(now());
    pruneErrors();
    evaluate();
  },

  /** Track agent activity for the swarm trigger. */
  reportAgentStatus(agentId: string, status: string) {
    activeAgents.set(agentId, status === "working" || status === "waiting");
    if (activeAgents.size > 500) {
      // Drop long-dead entries so the map can't grow unbounded.
      for (const [id, active] of activeAgents) {
        if (!active) activeAgents.delete(id);
        if (activeAgents.size <= 250) break;
      }
    }
    evaluate();
  },

  /** 10-second ULTRON takeover after a run kill. */
  killFlash() {
    killFlashUntil = now() + KILL_FLASH_MS;
    evaluate();
  },

  /**
   * Temporary calm-down: drops any manual pin back to "auto" and forces
   * JARVIS for DISMISS_MS. Unlike setSetting("jarvis"), this does not stick —
   * once the window elapses, auto-triggers resume and can flip back to
   * ULTRON if the condition that caused it is still active.
   */
  dismiss() {
    writeManual("auto");
    dismissUntil = now() + DISMISS_MS;
    evaluate();
  },

  /** Initialise from the persisted setting (call once at app start).
   *  A `?hud=jarvis|ultron|auto` URL param overrides and persists - handy for
   *  deep links and headless screenshots. */
  init() {
    try {
      const param = new URLSearchParams(window.location.search).get("hud");
      if (param === "jarvis" || param === "ultron" || param === "auto") {
        writeManual(param);
      }
      document.documentElement.dataset.theme = currentMode;
    } catch {
      /* non-DOM */
    }
    evaluate();
  },
};

// ── Incantation listener ─────────────────────────────────────────────────────
// Typing "ultron" anywhere pins ULTRON (sticks until changed again). Typing
// "jarvis" only dismisses it temporarily (see hudMode.dismiss()) - if the
// trigger that caused ULTRON is still active once the snooze elapses, it
// comes back.
// (Deliberately also fires inside inputs - speaking the name summons him.)

const INCANTATIONS: Array<{ word: string; action: () => void }> = [
  { word: "ultron", action: () => hudMode.setSetting("ultron") },
  { word: "jarvis", action: () => hudMode.dismiss() },
];
const MAX_WORD = Math.max(...INCANTATIONS.map((i) => i.word.length));
let keyBuffer = "";

export function installIncantationListener(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    keyBuffer = (keyBuffer + e.key.toLowerCase()).slice(-MAX_WORD);
    for (const { word, action } of INCANTATIONS) {
      if (keyBuffer.endsWith(word)) {
        keyBuffer = "";
        action();
        break;
      }
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

// ── Dev console bridge ───────────────────────────────────────────────────────
// In dev builds only, expose `window.__hud` so you can drive every mode and
// AUTO trigger from the browser console without any real agents or errors.
// Type `__hud.help()` in the console for the menu.

const devSwarmIds: string[] = [];

export function installDevBridge(): void {
  if (typeof window === "undefined") return;
  const bridge = {
    /** Pin ULTRON regardless of triggers. */
    ultron: () => hudMode.setSetting("ultron"),
    /** Pin JARVIS regardless of triggers. */
    jarvis: () => hudMode.setSetting("jarvis"),
    /** Let the automatic triggers decide (default). */
    auto: () => hudMode.setSetting("auto"),
    /** Fire the error-storm trigger (3 errors inside 60s → ULTRON in AUTO). */
    errorStorm: (n = 3) => {
      hudMode.setSetting("auto");
      for (let i = 0; i < n; i++) hudMode.reportError();
      return `reported ${n} errors - ULTRON holds ~60s (in AUTO)`;
    },
    /** Simulate a swarm of n working agents (5+ → ULTRON in AUTO). */
    swarm: (n = 5) => {
      hudMode.setSetting("auto");
      while (devSwarmIds.length < n) {
        const id = `dev-swarm-${devSwarmIds.length}`;
        devSwarmIds.push(id);
        hudMode.reportAgentStatus(id, "working");
      }
      return `swarm of ${n} - ULTRON holds while ≥5 (in AUTO). __hud.calm() to disperse.`;
    },
    /** Disperse the simulated swarm. */
    calm: () => {
      for (const id of devSwarmIds) hudMode.reportAgentStatus(id, "completed");
      devSwarmIds.length = 0;
      return "swarm dispersed";
    },
    /** 10-second ULTRON flash, as if a run was killed. */
    killFlash: () => {
      hudMode.setSetting("auto");
      hudMode.killFlash();
      return "kill flash - ULTRON for 10s (in AUTO)";
    },
    /** Temporary snooze back to JARVIS, same as typing the "jarvis" incantation. */
    dismiss: () => {
      hudMode.dismiss();
      return "dismissed - JARVIS for 15s, then AUTO re-evaluates triggers";
    },
    help: () => {
      // eslint-disable-next-line no-console
      console.log(
        [
          "JARVIS HUD dev console - window.__hud",
          "  __hud.ultron()      pin ULTRON",
          "  __hud.jarvis()      pin JARVIS",
          "  __hud.dismiss()     snooze to JARVIS for 15s (in AUTO), then re-evaluate",
          "  __hud.auto()        triggers decide (default)",
          "  __hud.errorStorm()  fire 3 errors → ULTRON ~60s",
          "  __hud.swarm(5)      simulate 5 working agents → ULTRON",
          "  __hud.calm()        disperse the swarm",
          "  __hud.killFlash()   10s ULTRON flash",
          "Tip: typing 'ultron' anywhere pins it; typing 'jarvis' only snoozes (see dismiss()). Or use ?hud=ultron.",
        ].join("\n")
      );
      return "see console";
    },
  };
  (window as unknown as { __hud: typeof bridge }).__hud = bridge;
  // eslint-disable-next-line no-console
  console.log("%cJARVIS HUD dev console ready - type __hud.help()", "color:#00c2e8");
}
