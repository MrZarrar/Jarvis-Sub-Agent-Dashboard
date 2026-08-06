/**
 * @file Projects.tsx
 * @description Projects (Phase F) - the dashboard-native organizing dimension
 * over sessions/runs/chats. Card grid with per-project rollups (linked
 * sessions/runs/chats, last activity) plus create. Deliberately separate from
 * Claude.ai's own "Projects" feature - this page and its API never talk to
 * that. Clicking a card opens ProjectDetail (edit/archive/paths/activity).
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FolderKanban,
  Plus,
  X,
  Clock,
  FolderOpen,
  Play,
  MessagesSquare,
  StickyNote,
  AlertTriangle,
} from "lucide-react";
import { api } from "../lib/api";
import { EmptyState } from "../components/EmptyState";
import { timeAgo, truncate, pathBasename } from "../lib/format";
import type { ProjectStatus, ProjectWithRollup, ProjectPulse, NoteMeta } from "../lib/types";

// State → dot color for the pulse indicator on each card.
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

const FILTERS: Array<{ key: ProjectStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "done", label: "Done" },
];

export function Projects() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ProjectWithRollup[]>([]);
  const [pulses, setPulses] = useState<Record<string, ProjectPulse>>({});
  const [filter, setFilter] = useState<ProjectStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.projects.list(filter === "all" ? undefined : filter);
      setItems(res.items);
      setError(null);
      // Pulse is derived data recomputed daily by the scheduler. Fetch it
      // best-effort; if none is stored yet but projects exist, prime it once.
      try {
        let pulseRes = await api.projects.pulse();
        if (pulseRes.items.length === 0 && res.items.length > 0) {
          pulseRes = await api.projects.recomputePulse();
        }
        setPulses(Object.fromEntries(pulseRes.items.map((p) => [p.projectId, p])));
      } catch {
        /* pulse is optional */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
            <FolderKanban className="w-4.5 h-4.5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">Projects</h1>
            <p className="text-xs text-gray-500">
              The organizing dimension across sessions, runs, and chats.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors"
        >
          {showCreate ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showCreate ? "Cancel" : "New Project"}
        </button>
      </div>

      {showCreate && (
        <div className="mb-6">
          <NewProjectForm
            onCreated={(id) => {
              setShowCreate(false);
              load();
              navigate(`/projects/${id}`);
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-6">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === f.key
                ? "bg-accent/15 text-accent border-accent/30"
                : "bg-surface-2 text-gray-400 border-border hover:text-gray-200 hover:bg-surface-3"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 mb-6">
          {error}
        </div>
      )}

      {(() => {
        const neglected = Object.values(pulses).filter((p) => p.state === "neglected");
        if (neglected.length === 0) return null;
        return (
          <div className="flex items-start gap-2 text-sm bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2.5 mb-6">
            <AlertTriangle className="w-4 h-4 text-red-300 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-gray-300">
              <span className="text-red-300 font-medium">Neglected:</span>{" "}
              {neglected.map((p) => `${p.projectName} (${p.daysSinceActivity ?? "?"}d)`).join(", ")}
            </div>
          </div>
        );
      })()}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project to group sessions, runs, and chats by cwd - the organizing dimension mini-Jarvis reads from."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              pulse={pulses[p.id]}
              onOpen={() => navigate(`/projects/${p.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  pulse,
  onOpen,
}: {
  project: ProjectWithRollup;
  pulse?: ProjectPulse;
  onOpen: () => void;
}) {
  const st = STATUS_STYLES[project.status];
  const { rollup } = project;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="holo-panel text-left card p-4 hover:border-accent/30 transition-colors group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-gray-100 truncate group-hover:text-accent transition-colors">
          {project.name}
        </h3>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border flex-shrink-0 ${st.cls}`}
        >
          {st.label}
        </span>
      </div>

      {project.description && (
        <p className="text-xs text-gray-500 mb-3 line-clamp-2">
          {truncate(project.description, 140)}
        </p>
      )}

      {project.repo_path && (
        <p className="text-[11px] text-gray-600 font-mono mb-3 truncate" title={project.repo_path}>
          {pathBasename(project.repo_path) || project.repo_path}
        </p>
      )}

      <div className="flex items-center gap-3 text-[11px] text-gray-500 mb-2">
        <span className="inline-flex items-center gap-1">
          <FolderOpen className="w-3 h-3" />
          {rollup.sessionCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <Play className="w-3 h-3" />
          {rollup.runCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <MessagesSquare className="w-3 h-3" />
          {rollup.chatCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <StickyNote className="w-3 h-3" />
          {rollup.noteCount ?? 0}
        </span>
      </div>

      {pulse ? (
        <div
          className="flex items-center gap-1.5 text-[10px] text-gray-500"
          title={`Pulse · ${pulse.state}`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PULSE_DOT[pulse.state] || "bg-slate-500"}`}
          />
          <span className="truncate">{pulse.summary}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-[10px] text-gray-600">
          <Clock className="w-3 h-3" />
          {rollup.lastActivityAt ? `Active ${timeAgo(rollup.lastActivityAt)}` : "No activity yet"}
        </div>
      )}
    </button>
  );
}

function NewProjectForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [linkNoteId, setLinkNoteId] = useState("");
  const [unlinkedNotes, setUnlinkedNotes] = useState<NoteMeta[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Existing vault "project" notes with no project link yet - offered so
  // creating a project can attach to one instead of leaving it for
  // ensureProjectStub() to auto-create a duplicate stub note later.
  useEffect(() => {
    api.notes
      .list({ tag: "project" })
      .then((res) => setUnlinkedNotes(res.items.filter((n) => !n.projectId)))
      .catch(() => {});
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!name.trim()) {
        setError("Name is required");
        return;
      }
      setSubmitting(true);
      try {
        const res = await api.projects.create({
          name: name.trim(),
          description: description.trim() || null,
          repoPath: repoPath.trim() || null,
        });
        if (linkNoteId) {
          await api.notes.update(linkNoteId, { projectId: res.project.id });
        }
        setName("");
        setDescription("");
        setRepoPath("");
        setLinkNoteId("");
        onCreated(res.project.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create project");
      } finally {
        setSubmitting(false);
      }
    },
    [name, description, repoPath, linkNoteId, onCreated]
  );

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none"
        />
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="Repo path (optional - absolute path, used for auto-association)"
          className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none font-mono"
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none resize-y"
      />
      {unlinkedNotes.length > 0 && (
        <select
          value={linkNoteId}
          onChange={(e) => setLinkNoteId(e.target.value)}
          className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 focus:border-accent/50 focus:outline-none"
        >
          <option value="">Link to existing vault note (optional)</option>
          {unlinkedNotes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create Project"}
        </button>
      </div>
    </form>
  );
}
