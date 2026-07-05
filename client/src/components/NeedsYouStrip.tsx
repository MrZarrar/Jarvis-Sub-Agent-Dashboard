/**
 * @file NeedsYouStrip.tsx
 * @description Priority-first "needs you now" strip (Phase R of
 *   PLAN-jarvis-v2.md). Surfaces the two things that actually block the user -
 *   live runs waiting on a permission decision, and recently failed runs -
 *   above the decorative instruments. Self-hides when nothing needs attention.
 *   Polls + refreshes on the run/permission WS broadcasts so it degrades
 *   safely if the socket is quiet. `readonly` renders plain rows (no links)
 *   for the /wall TV mode, which must never offer actions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldQuestion, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type RunHandle, type DashboardRunHistoryItem } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { WSMessage } from "../lib/types";

const FAILED_WINDOW_MS = 6 * 60 * 60 * 1000; // failed runs older than 6h stop nagging
const MAX_ITEMS = 5;
const POLL_MS = 15000;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function dirName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function agoLabel(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return t("nav:justNow");
  if (min < 60) return t("nav:minutesAgo", { count: min });
  return t("nav:hoursAgo", { count: Math.floor(min / 60) });
}

interface NeedsYouStripProps {
  /** TV /wall mode: render rows as plain text, no links, no actions. */
  readonly?: boolean;
}

export function NeedsYouStrip({ readonly = false }: NeedsYouStripProps) {
  const { t } = useTranslation("dashboard");
  const [liveRuns, setLiveRuns] = useState<RunHandle[]>([]);
  const [failedRuns, setFailedRuns] = useState<DashboardRunHistoryItem[]>([]);

  const load = useCallback(async () => {
    try {
      const [list, history] = await Promise.all([api.run.list(), api.run.history(20)]);
      setLiveRuns(list.items.filter((r) => r.status === "running" || r.status === "spawning"));
      const cutoff = Date.now() - FAILED_WINDOW_MS;
      setFailedRuns(
        history.items.filter(
          (r) =>
            r.status === "error" &&
            !r.isLive &&
            r.ended_at !== null &&
            new Date(r.ended_at).getTime() >= cutoff
        )
      );
    } catch {
      /* strip is best-effort chrome - never surface its own errors */
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    const unsubscribe = eventBus.subscribe((msg: WSMessage) => {
      if (
        msg.type === "permission_request" ||
        msg.type === "permission_resolved" ||
        msg.type === "run_status"
      ) {
        load();
      }
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [load]);

  const waiting = useMemo(
    () => liveRuns.filter((r) => (r.pendingPermissions || []).some((p) => p.status === "pending")),
    [liveRuns]
  );

  const items = useMemo(() => {
    const rows: Array<{
      key: string;
      runId: string;
      icon: typeof ShieldQuestion;
      tone: "amber" | "red";
      label: string;
      detail: string;
    }> = [];
    for (const r of waiting) {
      const count = r.pendingPermissions.filter((p) => p.status === "pending").length;
      rows.push({
        key: `perm-${r.id}`,
        runId: r.id,
        icon: ShieldQuestion,
        tone: "amber",
        label: t("needsYou.permission", {
          count,
          run: `${shortId(r.id)} (${dirName(r.cwd)})`,
        }),
        detail: t("needsYou.permissionHint"),
      });
    }
    for (const r of failedRuns) {
      rows.push({
        key: `fail-${r.id}`,
        runId: r.id,
        icon: XCircle,
        tone: "red",
        label: t("needsYou.failed", {
          run: `${shortId(r.id)} (${dirName(r.cwd)})`,
          exit: r.exit_code ?? "?",
        }),
        detail: r.ended_at ? agoLabel(r.ended_at, t) : "",
      });
    }
    return rows.slice(0, MAX_ITEMS);
  }, [waiting, failedRuns, t]);

  if (items.length === 0) return null;

  return (
    <div className="holo-panel hud-frame border-amber-500/25 p-3 sm:p-4 space-y-2 animate-fade-in">
      <h3 className="hud-label text-xs text-amber-300 flex items-center gap-2">
        {t("needsYou.title")}
        <span className="font-mono text-amber-400/70">{items.length}</span>
      </h3>
      {items.map(({ key, runId, icon: Icon, tone, label, detail }) => {
        const row = (
          <div
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              tone === "amber"
                ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-100"
                : "border-red-500/30 bg-red-500/[0.06] text-red-100"
            } ${readonly ? "" : "hover:bg-surface-2/80"}`}
          >
            <Icon
              className={`w-4 h-4 flex-shrink-0 ${tone === "amber" ? "text-amber-400" : "text-red-400"}`}
              aria-hidden
            />
            <span className="min-w-0 truncate flex-1">{label}</span>
            {detail && <span className="text-xs text-gray-500 flex-shrink-0">{detail}</span>}
          </div>
        );
        return readonly ? (
          <div key={key}>{row}</div>
        ) : (
          <Link key={key} to={`/run?runId=${encodeURIComponent(runId)}`} className="block">
            {row}
          </Link>
        );
      })}
    </div>
  );
}
