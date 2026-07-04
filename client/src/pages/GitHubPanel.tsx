/**
 * @file GitHubPanel.tsx
 * @description Full GitHub dev-workflow page (Phase I): the latest update per
 * repo (most recent commit or merge, by branch + message — never the raw SHA),
 * PRs awaiting your review, your open PRs (with CI status), and recent issues
 * across the configured repos, plus an inline config editor (watched repos +
 * PAT + poll cadence). Backed by the local `gh` CLI or a server-side PAT — all
 * calls are server-side; the token is never shipped to the client (only a
 * `hasPat` boolean).
 *
 * Loads the cached overview on mount, live-updates on `github_updated`, and
 * degrades safely if the WS event is delayed. CI status is only available in
 * `gh` mode (see the honest note rendered in PAT mode).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Github,
  GitPullRequest,
  GitCommit,
  GitMerge,
  CircleDot,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Settings2,
  ExternalLink,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type {
  GitHubConfig,
  GitHubOverviewResponse,
  GitHubPr,
  GitHubIssue,
  GitHubLatestCommit,
  GitHubCi,
  WSMessage,
} from "../lib/types";
import { timeAgo } from "../lib/format";

function CiBadge({ ci }: { ci: GitHubCi }) {
  if (ci === "success")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" /> passing
      </span>
    );
  if (ci === "failure")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-400">
        <XCircle className="w-3.5 h-3.5" /> failing
      </span>
    );
  if (ci === "pending")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <Clock className="w-3.5 h-3.5" /> pending
      </span>
    );
  return null; // "none" / "unknown" → render nothing
}

function PrRow({ pr }: { pr: GitHubPr }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-3/60 transition-colors group"
    >
      <GitPullRequest className="w-4 h-4 flex-shrink-0 text-accent/70" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-gray-100 truncate group-hover:text-accent">{pr.title}</span>
          {pr.isDraft && <span className="badge text-[10px]">draft</span>}
        </div>
        <div className="text-[11px] text-gray-500 truncate">
          {pr.repo} #{pr.number}
          {pr.author ? ` · ${pr.author}` : ""}
          {pr.updatedAt ? ` · ${timeAgo(pr.updatedAt)}` : ""}
        </div>
      </div>
      <CiBadge ci={pr.ci} />
      <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-gray-600 group-hover:text-accent" />
    </a>
  );
}

function LatestCommitRow({ commit }: { commit: GitHubLatestCommit }) {
  const headline =
    commit.isMerge && commit.mergedPr
      ? `Merged PR #${commit.mergedPr.number}${commit.mergedPr.title ? `: ${commit.mergedPr.title}` : ""}`
      : commit.message;
  return (
    <a
      href={commit.url || undefined}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-3/60 transition-colors group"
    >
      {commit.isMerge ? (
        <GitMerge className="w-4 h-4 flex-shrink-0 text-accent/70" />
      ) : (
        <GitCommit className="w-4 h-4 flex-shrink-0 text-gray-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-100 truncate group-hover:text-accent">{headline}</div>
        <div className="text-[11px] text-gray-500 truncate">
          {commit.repo} · {commit.branch}
          {commit.isMerge && commit.mergedPr ? ` (from ${commit.mergedPr.fromRef})` : ""}
          {commit.author ? ` · ${commit.author}` : ""}
          {commit.date ? ` · ${timeAgo(commit.date)}` : ""}
        </div>
      </div>
      {commit.url && (
        <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-gray-600 group-hover:text-accent" />
      )}
    </a>
  );
}

function IssueRow({ issue }: { issue: GitHubIssue }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-3/60 transition-colors group"
    >
      <CircleDot className="w-4 h-4 flex-shrink-0 text-emerald-500/70" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-100 truncate group-hover:text-accent">{issue.title}</div>
        <div className="text-[11px] text-gray-500 truncate">
          {issue.repo} #{issue.number}
          {issue.author ? ` · ${issue.author}` : ""}
          {issue.updatedAt ? ` · ${timeAgo(issue.updatedAt)}` : ""}
        </div>
      </div>
      <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-gray-600 group-hover:text-accent" />
    </a>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        <span className="badge">{count}</span>
      </div>
      {count === 0 ? (
        <p className="text-xs text-gray-500 px-3 py-2">{empty}</p>
      ) : (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </div>
  );
}

function ConfigEditor({ config, onSaved }: { config: GitHubConfig; onSaved: () => void }) {
  const [repos, setRepos] = useState(config.repos.join("\n"));
  const [pat, setPat] = useState("");
  const [pollMinutes, setPollMinutes] = useState(config.pollMinutes);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // `after` receives the server's resolved config so a caller can react to what
  // actually got saved — critical for repos, where an unparseable line (e.g. a
  // pasted URL in the wrong shape) is silently dropped server-side otherwise,
  // and the textarea would look "saved" while quietly holding stale text.
  const save = async (
    patch: Parameters<typeof api.github.updateConfig>[0],
    after?: (cfg: GitHubConfig) => void
  ) => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.github.updateConfig(patch);
      setPat("");
      if (after) after(res.config);
      else setMsg("Saved");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveRepos = () => {
    const lines = repos
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);
    save({ repos: lines }, (cfg) => {
      // Reflect exactly what was persisted — normalized form, in saved order —
      // so a URL you pasted shows up rewritten as "owner/name" immediately.
      setRepos(cfg.repos.join("\n"));
      const dropped = lines.length - cfg.repos.length;
      setMsg(
        dropped > 0
          ? `Saved ${cfg.repos.length} repo(s) — ${dropped} line(s) couldn't be parsed and were dropped. Use "owner/name" or a github.com URL.`
          : `Saved ${cfg.repos.length} repo(s)`
      );
    });
  };

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-accent/80" />
        <h2 className="text-sm font-semibold text-gray-200">Configuration</h2>
        {msg && <span className="ml-auto text-xs text-gray-400">{msg}</span>}
      </div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">
          Watched repos (one per line — <code>owner/name</code> or a github.com URL)
        </label>
        <textarea
          className="input w-full font-mono text-sm min-h-[5rem]"
          value={repos}
          onChange={(e) => setRepos(e.target.value)}
          placeholder="owner/name&#10;https://github.com/your-org/another-repo"
        />
        <button className="btn-secondary mt-2 text-xs" disabled={saving} onClick={saveRepos}>
          Save repos
        </button>
      </div>

      <div className="border-t border-border pt-4">
        <label className="text-xs text-gray-400 block mb-1">
          Personal Access Token{" "}
          {config.hasPat ? "(set — leave blank to keep)" : "(optional — uses gh CLI if empty)"}
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            className="input flex-1 font-mono text-sm"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder={config.hasPat ? "••••••••" : "ghp_…"}
          />
          <button
            className="btn-secondary text-xs"
            disabled={saving || !pat}
            onClick={() => save({ pat })}
          >
            Save token
          </button>
          {config.hasPat && (
            <button
              className="btn-secondary text-xs"
              disabled={saving}
              onClick={() => save({ pat: "" })}
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          With no token, the locally-authenticated <code>gh</code> CLI is used (recommended). A
          token makes it portable to hosts without <code>gh</code>, but per-PR CI status is only
          shown in gh mode.
        </p>
      </div>

      <div className="border-t border-border pt-4 flex items-end gap-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Poll cadence (minutes)</label>
          <input
            type="number"
            min={1}
            max={180}
            className="input w-24 text-sm"
            value={pollMinutes}
            onChange={(e) => setPollMinutes(Number(e.target.value))}
          />
        </div>
        <button
          className="btn-secondary text-xs"
          disabled={saving}
          onClick={() => save({ pollMinutes })}
        >
          Save cadence
        </button>
        <span className="text-[11px] text-gray-500 ml-1 mb-1.5">Takes effect on next restart.</span>
      </div>
    </div>
  );
}

export function GitHubPanel() {
  const [data, setData] = useState<GitHubOverviewResponse | null>(null);
  const [config, setConfig] = useState<GitHubConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ov, cfg] = await Promise.all([api.github.overview(), api.github.config()]);
      setData(ov);
      setConfig(cfg.config);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load GitHub data");
    }
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "github_updated") load();
    });
  }, [load]);

  // Open the config editor by default when nothing is configured yet.
  useEffect(() => {
    if (config && !config.enabled) setShowConfig(true);
    if (config && config.repos.length === 0) setShowConfig(true);
  }, [config]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const ov = await api.github.refresh();
      setData(ov);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const ov = data?.overview;

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center gap-3 flex-wrap">
        <Github className="w-6 h-6 text-accent" />
        <h1 className="text-xl font-semibold text-gray-100">GitHub</h1>
        {data && (
          <span className="badge text-[10px] uppercase">
            {data.mode === "none" ? "not connected" : data.mode === "gh" ? "gh cli" : "pat"}
          </span>
        )}
        {data?.fetchedAt && (
          <span className="text-xs text-gray-500">updated {timeAgo(data.fetchedAt)}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-secondary text-xs" onClick={() => setShowConfig((s) => !s)}>
            <Settings2 className="w-3.5 h-3.5 inline mr-1" />
            {showConfig ? "Hide config" : "Configure"}
          </button>
          <button className="btn-secondary text-xs" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={`w-3.5 h-3.5 inline mr-1 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="card p-3 border-red-500/30 text-sm text-red-400">{error}</div>}

      {ov?.error && (
        <div className="card p-3 border-amber-500/30 text-sm text-amber-400">
          GitHub fetch problem: {ov.error}
        </div>
      )}

      {showConfig && config && <ConfigEditor config={config} onSaved={load} />}

      {data && !data.configured && !showConfig && (
        <div className="card p-6 text-center text-sm text-gray-400">
          No repos configured yet.{" "}
          <button className="text-accent underline" onClick={() => setShowConfig(true)}>
            Add some repos
          </button>{" "}
          to see open PRs, CI status, and issues.
        </div>
      )}

      {ov && data?.configured && ov.latest.length > 0 && (
        <Section title="Latest activity" count={ov.latest.length} empty="No commits found.">
          {ov.latest.map((commit) => (
            <LatestCommitRow
              key={`${commit.repo}:${commit.branch}:${commit.date ?? commit.message}`}
              commit={commit}
            />
          ))}
        </Section>
      )}

      {ov && data?.configured && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Section
            title="Needs your review"
            count={ov.counts.reviewRequested}
            empty="Nothing waiting on you."
          >
            {ov.reviewRequested.map((pr) => (
              <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
            ))}
          </Section>

          <Section title="Your open PRs" count={ov.counts.mine} empty="No open PRs.">
            {ov.mine.map((pr) => (
              <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
            ))}
          </Section>

          <Section title="Recent issues" count={ov.counts.openIssues} empty="No open issues.">
            {ov.issues.map((issue) => (
              <IssueRow key={`${issue.repo}#${issue.number}`} issue={issue} />
            ))}
          </Section>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-2">Summary</h2>
            <ul className="text-sm text-gray-400 space-y-1">
              <li>{ov.counts.reviewRequested} PR(s) awaiting your review</li>
              <li className={ov.counts.failingChecks > 0 ? "text-red-400" : ""}>
                {ov.counts.failingChecks} check(s) failing
              </li>
              <li>{ov.counts.mine} of your PRs open</li>
              <li>{ov.counts.openIssues} open issue(s)</li>
            </ul>
            {data.mode === "pat" && (
              <p className="text-[11px] text-gray-500 mt-3">
                CI status isn't fetched in PAT mode — connect the <code>gh</code> CLI for per-PR
                checks.
              </p>
            )}
            {ov.repos.length > 0 && (
              <p className="text-[11px] text-gray-600 mt-3 truncate">
                Watching: {ov.repos.join(", ")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
