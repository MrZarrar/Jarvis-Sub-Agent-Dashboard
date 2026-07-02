/**
 * @file SteerPanel.tsx
 * @description Redirect channel for a session, surfaced on the session detail
 *   page. Two paths, both riding Claude Code's native queued-message
 *   mechanism (delivered at the next tool-call boundary — true mid-tool
 *   interrupt does not exist):
 *   - The session is a live dashboard run → message goes straight into the
 *     running process's stdin via POST /api/run/:id/message.
 *   - Otherwise → "resume & steer": spawn `claude --resume <session-id>` in
 *     conversation mode with the message as the first turn. Note this drives
 *     a NEW process resuming the conversation; it does not inject into a
 *     terminal running elsewhere.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radio, Send, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type RunHandle } from "../lib/api";
import type { Session } from "../lib/types";

interface SteerPanelProps {
  session: Session;
  /** True while the session itself still reports an active status. */
  sessionActive: boolean;
}

export function SteerPanel({ session, sessionActive }: SteerPanelProps) {
  const { t } = useTranslation("sessions");
  const [text, setText] = useState("");
  const [liveRun, setLiveRun] = useState<RunHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  const refreshLiveRun = useCallback(async () => {
    try {
      const { items } = await api.run.list();
      setLiveRun(
        items.find(
          (r) => r.sessionId === session.id && (r.status === "running" || r.status === "spawning")
        ) ?? null
      );
    } catch {
      setLiveRun(null);
    }
  }, [session.id]);

  useEffect(() => {
    refreshLiveRun();
  }, [refreshLiveRun]);

  const transmit = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (liveRun) {
        await api.run.send(liveRun.id, message);
        setNotice({
          kind: "ok",
          msg: t(
            "detail.steer.queued",
            "Transmitted — queued for delivery at the next tool-call boundary."
          ),
        });
      } else {
        const handle = await api.run.start({
          mode: "conversation",
          resumeSessionId: session.id,
          prompt: message,
          cwd: session.cwd || undefined,
        });
        setStartedRunId(handle.id);
        setNotice({
          kind: "ok",
          msg: t(
            "detail.steer.resumed",
            "Session resumed under dashboard control — your message is the next turn."
          ),
        });
        refreshLiveRun();
      }
      setText("");
    } catch (err) {
      setNotice({
        kind: "error",
        msg: err instanceof Error ? err.message : t("detail.steer.failed", "Transmission failed"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card hud-frame p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="hud-label inline-flex items-center gap-2">
          <Radio className="w-3.5 h-3.5" />
          {t("detail.steer.title", "Steer this agent")}
        </span>
        {liveRun ? (
          <span className="badge border-accent/40 text-accent bg-accent/10">
            {t("detail.steer.liveChannel", "Live channel")}
          </span>
        ) : (
          <span className="badge border-border text-gray-500 bg-surface-2">
            {t("detail.steer.resumeChannel", "Resume & steer")}
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        {liveRun
          ? t(
              "detail.steer.liveHint",
              "This session runs under dashboard control. Messages are queued into it and delivered at the next tool-call boundary — non-destructive, not instant."
            )
          : sessionActive
            ? t(
                "detail.steer.activeExternalHint",
                "This session is running outside the dashboard — a message here resumes the conversation in a new dashboard-driven process rather than injecting into the external terminal. To steer the original, reply inside it (or `claude agents`)."
              )
            : t(
                "detail.steer.endedHint",
                "Resumes this conversation under dashboard control with your message as the next turn."
              )}
      </p>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) transmit();
          }}
          rows={2}
          placeholder={t(
            "detail.steer.placeholder",
            "Redirect the agent — e.g. “Stop refactoring, focus on the failing test first.”"
          )}
          className="input flex-1 resize-y min-h-[3.25rem] font-mono text-xs"
        />
        <button
          onClick={transmit}
          disabled={busy || !text.trim()}
          className="btn-primary disabled:opacity-40 disabled:pointer-events-none"
        >
          <Send className="w-3.5 h-3.5" />
          {t("detail.steer.transmit", "Transmit")}
        </button>
      </div>
      {notice && (
        <div
          className={`mt-2 text-[11px] flex items-center gap-2 ${
            notice.kind === "ok" ? "text-accent" : "text-red-400"
          }`}
        >
          <span>{notice.msg}</span>
          {startedRunId && (
            <Link
              to={`/run?session=${encodeURIComponent(session.id)}`}
              className="inline-flex items-center gap-1 underline decoration-dotted hover:text-accent-hover"
            >
              {t("detail.steer.watchRun", "watch the run")}
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
