/**
 * @file ProjectDetail.tsx
 * @description Project detail view (Phase F) - edit/archive/delete, manage
 * the repo paths used for cwd auto-association, and an aggregated activity
 * feed (recent sessions/runs/chats). Live-refreshes on session/run WS events
 * so counts and the feed stay current without a manual reload.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  FolderKanban,
  Trash2,
  Plus,
  X,
  FolderOpen,
  Play,
  MessagesSquare,
  StickyNote,
  Activity,
  AlertCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { EmptyState } from "../components/EmptyState";
import { formatDateTime, timeAgo, truncate, pathBasename } from "../lib/format";
import type {
  Project,
  ProjectPath,
  ProjectRollup,
  ProjectPulseRow,
  ProjectStatus,
} from "../lib/types";

const PULSE_DOT: Record<string, string> = {
  active: "bg-emerald-400",
  neglected: "bg-red-400",
  idle: "bg-slate-500",
  paused: "bg-amber-400",
  completed: "bg-sky-400",
};

const STATUS_STYLES: Record<ProjectStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25" },
  paused: { label: "Paused", cls: "text-amber-300 bg-amber-500/10 border-amber-500/25" },
  done: { label: "Done", cls: "text-slate-400 bg-slate-500/10 border-slate-500/25" },
};

const REFRESH_WS_TYPES = new Set([
  "session_created",
  "session_updated",
  "run_status",
  "agent_updated",
]);

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [rollup, setRollup] = useState<ProjectRollup | null>(null);
  const [pulse, setPulse] = useState<ProjectPulseRow | null>(null);
  const [paths, setPaths] = useState<ProjectPath[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.projects.get(id);
      setProject(res.project);
      setRollup(res.rollup);
      setPulse(res.pulse);
      setPaths(res.paths);
      setNotFound(false);
      setError(null);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    return eventBus.subscribe((msg) => {
      if (REFRESH_WS_TYPES.has(msg.type)) load();
    });
  }, [load]);

  const updateField = useCallback(
    async (patch: Parameters<typeof api.projects.update>[1]) => {
      if (!id) return;
      try {
        const res = await api.projects.update(id, patch);
        setProject(res.project);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update project");
      }
    },
    [id]
  );

  const onDelete = useCallback(async () => {
    if (!id || !project) return;
    if (
      !window.confirm(
        `Delete "${project.name}"?\n\nThis only removes the project grouping - sessions, runs, and chats stay untouched.`
      )
    ) {
      return;
    }
    try {
      await api.projects.remove(id);
      navigate("/projects");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    }
  }, [id, project, navigate]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  if (notFound || !project) {
    return (
      <EmptyState
        icon={FolderKanban}
        title="Project not found"
        description="It may have been deleted."
        action={
          <Link to="/projects" className="btn-ghost">
            <ArrowLeft className="w-4 h-4" /> Back to Projects
          </Link>
        }
      />
    );
  }

  const st = STATUS_STYLES[project.status];

  return (
    <div className="animate-fade-in max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate("/projects")} className="btn-ghost flex-shrink-0">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center flex-shrink-0">
              <FolderKanban className="w-5 h-5 text-accent" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-gray-50 truncate">{project.name}</h1>
              {project.description && (
                <p className="text-xs text-gray-500 mt-0.5">{project.description}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onDelete}
            title="Delete project"
            className="p-2 rounded-lg text-gray-500 hover:text-red-300 hover:bg-red-500/10 transition-colors flex-shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {(["active", "paused", "done"] as ProjectStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => updateField({ status: s })}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                project.status === s
                  ? STATUS_STYLES[s].cls
                  : "bg-surface-2 text-gray-400 border-border hover:text-gray-200"
              }`}
            >
              {STATUS_STYLES[s].label}
            </button>
          ))}
          <span
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${st.cls}`}
          >
            {st.label}
          </span>
        </div>
      </div>

      <ProjectPathsCard
        paths={paths}
        onAdd={async (repoPath) => {
          if (!id) return;
          await api.projects.addPath(id, repoPath);
          load();
        }}
        onRemove={async (pathId) => {
          if (!id) return;
          await api.projects.removePath(id, pathId);
          load();
        }}
      />

      {pulse && (
        <div className="flex items-center gap-2.5 card px-4 py-3">
          <Activity className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${PULSE_DOT[pulse.state] || "bg-slate-500"}`}
          />
          <span className="text-sm text-gray-200">{pulse.summary}</span>
          <span className="text-[11px] text-gray-600 ml-auto">
            pulse updated {timeAgo(pulse.computed_at)}
          </span>
        </div>
      )}

      {rollup && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatTile icon={FolderOpen} label="Sessions" value={rollup.sessionCount} />
          <StatTile icon={Play} label="Runs" value={rollup.runCount} />
          <StatTile icon={MessagesSquare} label="Chats" value={rollup.chatCount} />
          <StatTile icon={StickyNote} label="Notes" value={rollup.noteCount ?? 0} />
        </div>
      )}

      {rollup && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ActivitySection title="Recent sessions" icon={FolderOpen}>
            {rollup.recentSessions.length === 0 ? (
              <p className="text-xs text-gray-500 italic px-1">No sessions yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {rollup.recentSessions.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/sessions/${s.id}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2/60 hover:bg-surface-3 transition-colors text-xs"
                    >
                      <span className="text-gray-200 truncate">
                        {s.name || `Session ${s.id.slice(0, 8)}`}
                      </span>
                      <span className="text-gray-500 flex-shrink-0">
                        {timeAgo(s.last_activity || s.started_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ActivitySection>

          <ActivitySection title="Recent runs" icon={Play}>
            {rollup.recentRuns.length === 0 ? (
              <p className="text-xs text-gray-500 italic px-1">No runs yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {rollup.recentRuns.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/run?runId=${encodeURIComponent(r.id)}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2/60 hover:bg-surface-3 transition-colors text-xs"
                    >
                      <span className="text-gray-200 truncate font-mono">
                        {truncate(r.prompt_preview || r.id.slice(0, 8), 50)}
                      </span>
                      <span className="text-gray-500 flex-shrink-0">
                        {r.status} · {formatDateTime(r.started_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ActivitySection>

          <ActivitySection title="Recent chats" icon={MessagesSquare}>
            {rollup.recentChats.length === 0 ? (
              <p className="text-xs text-gray-500 italic px-1">
                No chats tagged yet - assign a chat to this project from the Chat API.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {rollup.recentChats.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2/60 text-xs"
                  >
                    <span className="text-gray-200 truncate">{c.title || "Untitled chat"}</span>
                    <span className="text-gray-500 flex-shrink-0">{timeAgo(c.updated_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </ActivitySection>

          <ActivitySection title="Recent notes" icon={StickyNote}>
            {(rollup.recentNotes?.length ?? 0) === 0 ? (
              <p className="text-xs text-gray-500 italic px-1">
                No notes tagged to this project yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {rollup.recentNotes.map((n) => (
                  <li key={n.id}>
                    <Link
                      to="/notes"
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2/60 hover:bg-surface-3 transition-colors text-xs"
                    >
                      <span className="text-gray-200 truncate">{n.title}</span>
                      <span className="text-gray-500 flex-shrink-0">{timeAgo(n.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ActivitySection>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FolderOpen;
  label: string;
  value: number;
}) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <span className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center flex-shrink-0">
        <Icon className="w-4 h-4 text-accent" />
      </span>
      <div>
        <div className="text-lg font-semibold text-gray-100 font-mono">{value}</div>
        <div className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</div>
      </div>
    </div>
  );
}

function ActivitySection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof FolderOpen;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-3.5 h-3.5 text-gray-500" />
        <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function ProjectPathsCard({
  paths,
  onAdd,
  onRemove,
}: {
  paths: ProjectPath[];
  onAdd: (repoPath: string) => Promise<void>;
  onRemove: (pathId: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!repoPath.trim()) return;
      setSubmitting(true);
      setError(null);
      try {
        await onAdd(repoPath.trim());
        setRepoPath("");
        setAdding(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add path");
      } finally {
        setSubmitting(false);
      }
    },
    [repoPath, onAdd]
  );

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
          Repo paths · auto-association
        </h3>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="p-1.5 rounded-lg text-gray-500 hover:text-accent hover:bg-accent/10 transition-colors"
          title="Add repo path"
        >
          {adding ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        Sessions and dashboard-spawned runs whose working directory sits inside one of these paths
        are tagged to this project automatically.
      </p>

      {adding && (
        <form onSubmit={submit} className="flex items-center gap-2 mb-3">
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/absolute/path/to/repo"
            className="flex-1 rounded-lg bg-surface-2 border border-border px-3 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none font-mono"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30 text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-60"
          >
            Add
          </button>
        </form>
      )}
      {error && <p className="text-xs text-red-300 mb-2">{error}</p>}

      {paths.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No paths yet - add one to enable auto-association.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {paths.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-surface-2/60 text-xs"
            >
              <span className="text-gray-300 font-mono truncate" title={p.repo_path}>
                {pathBasename(p.repo_path) || p.repo_path}
              </span>
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                className="text-gray-500 hover:text-red-300 transition-colors flex-shrink-0"
                title="Remove path"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
