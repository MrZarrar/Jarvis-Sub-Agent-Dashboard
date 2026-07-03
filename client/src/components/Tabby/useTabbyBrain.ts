/**
 * @file useTabbyBrain.ts
 * @description React hook that wires the pure Tabby brain to the live event bus
 *   and to real timers. It is the only unit that subscribes to `eventBus`. It
 *   exposes the derived mood, a status summary, the current speech bubble, and
 *   imperative controls (mute, clear alerts, set thinking) for the UI shell.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { eventBus } from "../../lib/eventBus";
import { api } from "../../lib/api";
import type { WSMessage } from "../../lib/types";
import {
  initialTabbyState,
  reduceTabby,
  deriveMood,
  statusOf,
  clearErrors,
  seedSessions,
  type Mood,
  type TabbyState,
  type TabbyStatus,
} from "./brain";
import { pickQuip } from "./quips";
import { tabbyPrefs } from "./prefs";

const BUBBLE_MS = 4500;
// Minimum gap between non-error bubbles, so a burst of activity doesn't spam.
const BUBBLE_THROTTLE_MS = 3000;

export interface TabbyBrain {
  mood: Mood;
  status: TabbyStatus;
  bubble: string | null;
  dismissBubble: () => void;
  muted: boolean;
  toggleMute: () => void;
  clearAlerts: () => void;
  setThinking: (v: boolean) => void;
  /** True while manually put to sleep via the panel's Sleep button. */
  asleep: boolean;
  toggleSleep: () => void;
}

export function useTabbyBrain(): TabbyBrain {
  const now0 = Date.now();
  // Start optimistically connected (idle, open eyes) so the cursor-tracking
  // eyes are live from the first frame instead of after the WebSocket finishes
  // its initial handshake. onConnection below corrects this if it's truly down.
  const [state, setState] = useState<TabbyState>(() => ({
    ...initialTabbyState(now0),
    connected: true,
    manualSleep: tabbyPrefs.getManualSleep(),
  }));
  const [tick, setTick] = useState(now0);
  const [bubble, setBubble] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(() => tabbyPrefs.getMuted());

  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastBubbleAt = useRef(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Keep mute + manual-sleep in sync with the Settings page / other tabs.
  useEffect(
    () =>
      tabbyPrefs.subscribe(() => {
        setMuted(tabbyPrefs.getMuted());
        setState((prev) => {
          const next = tabbyPrefs.getManualSleep();
          return prev.manualSleep === next ? prev : { ...prev, manualSleep: next };
        });
      }),
    []
  );

  const showBubble = useCallback((text: string, force: boolean) => {
    if (!text) return;
    if (mutedRef.current) return;
    const t = Date.now();
    if (!force && t - lastBubbleAt.current < BUBBLE_THROTTLE_MS) return;
    lastBubbleAt.current = t;
    clearTimeout(bubbleTimer.current);
    setBubble(text);
    bubbleTimer.current = setTimeout(() => setBubble(null), BUBBLE_MS);
  }, []);

  // Seed from the REST snapshot on mount so counts are accurate immediately -
  // the brain otherwise only learns about sessions from WS deltas that arrive
  // after it mounts, showing "0 live" on a fresh load even when sessions exist.
  // Pull a generous page of non-finished sessions; live WS deltas refine it.
  useEffect(() => {
    let cancelled = false;
    api.sessions
      .list({ status: "active", limit: 100 })
      .then((res) => {
        if (cancelled) return;
        setState((prev) => seedSessions(prev, res.sessions, Date.now()));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to the live stream and connection status.
  useEffect(() => {
    const unsubMsg = eventBus.subscribe((msg: WSMessage) => {
      const t = Date.now();
      setState((prev) => {
        const { state: next, pulse } = reduceTabby(prev, msg, t);
        if (pulse) showBubble(pickQuip(pulse), pulse === "error");
        return next;
      });
    });
    const unsubConn = eventBus.onConnection((connected) => {
      setState((prev) => ({ ...prev, connected }));
    });
    return () => {
      unsubMsg();
      unsubConn();
    };
  }, [showBubble]);

  // Advance the clock so timed moods (stuck/sleeping, and exit from
  // happy/worried) re-evaluate without needing a new event.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => clearTimeout(bubbleTimer.current), []);

  const mood = useMemo(() => deriveMood(state, tick), [state, tick]);
  const status = useMemo(() => statusOf(state), [state]);

  const dismissBubble = useCallback(() => {
    clearTimeout(bubbleTimer.current);
    setBubble(null);
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    tabbyPrefs.setMuted(next);
    setMuted(next);
    if (next) dismissBubble();
  }, [dismissBubble]);

  const clearAlerts = useCallback(() => setState((prev) => clearErrors(prev)), []);

  const setThinking = useCallback(
    (v: boolean) => setState((prev) => (prev.thinking === v ? prev : { ...prev, thinking: v })),
    []
  );

  const toggleSleep = useCallback(() => {
    setState((prev) => {
      const next = !prev.manualSleep;
      tabbyPrefs.setManualSleep(next);
      return { ...prev, manualSleep: next };
    });
  }, []);

  return {
    mood,
    status,
    bubble,
    dismissBubble,
    muted,
    toggleMute,
    clearAlerts,
    setThinking,
    asleep: state.manualSleep,
    toggleSleep,
  };
}
