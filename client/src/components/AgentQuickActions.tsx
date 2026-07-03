/**
 * @file AgentQuickActions.tsx
 * @description Inline Pause / Stop controls for a session's main agent, shown
 *   on the home page so you can intervene without opening the session. Both
 *   ride the dashboard's real run-control channel:
 *     - Stop  → api.run.kill() on the live run driving this session.
 *     - Pause → a queued steer message delivered at the next tool boundary
 *       ("finish the current step, then wait") — the same non-destructive,
 *       queued mechanism Claude Code's own inline reply uses.
 *   These act on runs the dashboard is driving (spawned or resumed). A session
 *   running in an external terminal can't be killed from here, so for those we
 *   fall back to a Steer link to the session's full control panel.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Pause, Square, Radio, Loader2, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type RunHandle } from "../lib/api";
import { hudMode } from "../lib/hudMode";

const PAUSE_MESSAGE = "Pause: finish the current step, then stop and wait for my next instruction.";

interface AgentQuickActionsProps {
  sessionId: string;
}

export function AgentQuickActions({ sessionId }: AgentQuickActionsProps) {
  const { t } = useTranslation("dashboard");
  const [liveRun, setLiveRun] = useState<RunHandle | null>(null);
  const [busy, setBusy] = useState<null | "pause" | "stop">(null);
  const [done, setDone] = useState<null | "paused" | "stopped">(null);
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!api.run || typeof api.run.list !== "function") return;
    api.run
      .list()
      .then(({ items }) => {
        if (cancelled) return;
        setLiveRun(
          items.find(
            (r) => r.sessionId === sessionId && (r.status === "running" || r.status === "spawning")
          ) ?? null
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const pause = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!liveRun || busy) return;
      setBusy("pause");
      try {
        await api.run.send(liveRun.id, PAUSE_MESSAGE);
        setDone("paused");
      } catch {
        /* surfaced by the session page; keep the home card quiet */
      } finally {
        setBusy(null);
      }
    },
    [liveRun, busy]
  );

  const stop = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (!liveRun || busy) return;
      if (!confirmStop) {
        setConfirmStop(true);
        return;
      }
      setBusy("stop");
      try {
        await api.run.kill(liveRun.id);
        setDone("stopped");
        hudMode.killFlash();
      } catch {
        /* ignore — parent poll will reconcile */
      } finally {
        setBusy(null);
        setConfirmStop(false);
      }
    },
    [liveRun, busy, confirmStop]
  );

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-accent" aria-live="polite">
        <Check className="w-3 h-3" />
        {done === "paused"
          ? t("quickActions.paused", "Pause queued")
          : t("quickActions.stopped", "Stopped")}
      </span>
    );
  }

  // External session (no dashboard-driven run) — can't kill the process from
  // here, so offer the full Steer panel instead.
  if (!liveRun) {
    return (
      <Link
        to={`/sessions/${sessionId}`}
        onClick={(e) => e.stopPropagation()}
        title={t("quickActions.steerHint", "Open steer controls")}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-gray-400 hover:text-accent hover:bg-accent/10 border border-transparent hover:border-accent/30 transition-colors"
      >
        <Radio className="w-3 h-3" />
        {t("quickActions.steer", "Steer")}
      </Link>
    );
  }

  return (
    <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={pause}
        disabled={busy !== null}
        title={t("quickActions.pauseHint", "Queue a pause at the next step")}
        className="inline-flex items-center justify-center w-6 h-6 rounded text-gray-400 hover:text-accent hover:bg-accent/10 border border-transparent hover:border-accent/30 transition-colors disabled:opacity-40"
      >
        {busy === "pause" ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Pause className="w-3 h-3" />
        )}
      </button>
      <button
        type="button"
        onClick={stop}
        disabled={busy !== null}
        title={t("quickActions.stopHint", "Kill this run")}
        className={`inline-flex items-center gap-1 justify-center h-6 rounded border transition-colors disabled:opacity-40 ${
          confirmStop
            ? "px-2 text-red-300 bg-red-500/15 border-red-500/40"
            : "w-6 text-gray-400 hover:text-red-300 hover:bg-red-500/10 border-transparent hover:border-red-500/30"
        }`}
      >
        {busy === "stop" ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <>
            <Square className="w-3 h-3" fill="currentColor" />
            {confirmStop && (
              <span className="text-[11px]">{t("quickActions.confirm", "Sure?")}</span>
            )}
          </>
        )}
      </button>
    </div>
  );
}
