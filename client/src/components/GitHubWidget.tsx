/**
 * @file GitHubWidget.tsx
 * @description Compact GitHub dev-workflow summary for the home command bridge
 * (Phase I): "2 PRs need review · 1 CI red" as tappable chips linking to the
 * full GitHub page. Self-hides when GitHub isn't configured (no repos / no
 * gh+PAT), so users who don't use it see nothing — same posture as AccountsStrip.
 *
 * Read-only summary; live-updates on the `github_updated` WebSocket event and
 * degrades safely if that event is delayed (it seeds from the cached overview on
 * mount, and the server keeps the cache warm via the poller).
 */

import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Github, GitPullRequest, CircleAlert, CircleDot, GitCommit, GitMerge } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { timeAgo } from "../lib/format";
import type { GitHubOverviewResponse, WSMessage } from "../lib/types";

export function GitHubWidget() {
  const [data, setData] = useState<GitHubOverviewResponse | null>(null);

  const load = useCallback(() => {
    const p = api.github?.overview?.();
    if (!p) {
      setData(null);
      return;
    }
    p.then(setData).catch(() => setData(null));
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "github_updated") load();
    });
  }, [load]);

  // Hidden until configured — nothing to show, and no clutter for non-users.
  if (!data || !data.configured) return null;

  const c = data.overview.counts;
  const chips: { icon: typeof Github; label: string; tone: string }[] = [];
  if (c.reviewRequested > 0)
    chips.push({
      icon: GitPullRequest,
      label: `${c.reviewRequested} need${c.reviewRequested === 1 ? "s" : ""} review`,
      tone: "text-accent",
    });
  if (c.failingChecks > 0)
    chips.push({ icon: CircleAlert, label: `${c.failingChecks} CI red`, tone: "text-red-400" });
  if (c.mine > 0)
    chips.push({
      icon: GitPullRequest,
      label: `${c.mine} my PR${c.mine === 1 ? "" : "s"}`,
      tone: "text-gray-300",
    });
  if (c.openIssues > 0)
    chips.push({
      icon: CircleDot,
      label: `${c.openIssues} issue${c.openIssues === 1 ? "" : "s"}`,
      tone: "text-gray-300",
    });

  // Most recent commit/merge across all watched repos (overview.latest is
  // already sorted newest-first).
  const latest = data.overview.latest[0];
  const latestHeadline =
    latest &&
    (latest.isMerge && latest.mergedPr
      ? `Merged PR #${latest.mergedPr.number}${latest.mergedPr.title ? `: ${latest.mergedPr.title}` : ""}`
      : latest.message);

  return (
    <NavLink
      to="/github"
      className="holo-panel hud-frame holo-boot flex flex-col gap-2 p-3 hover:border-accent/40 transition-colors"
      style={{ "--boot-delay": "0.62s" } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <Github className="w-4 h-4 flex-shrink-0 text-accent/80" />
        <span className="hud-label">GitHub</span>
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
      </div>
      {latest && (
        <div className="flex items-center gap-2 min-w-0 pl-7 text-xs text-gray-400">
          {latest.isMerge ? (
            <GitMerge className="w-3.5 h-3.5 flex-shrink-0 text-accent/60" />
          ) : (
            <GitCommit className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
          )}
          <span className="truncate">{latestHeadline}</span>
          <span className="text-gray-600 flex-shrink-0">
            {latest.repo} · {latest.branch}
            {latest.date ? ` · ${timeAgo(latest.date)}` : ""}
          </span>
        </div>
      )}
    </NavLink>
  );
}
