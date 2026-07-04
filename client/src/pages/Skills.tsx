/**
 * @file Skills.tsx
 * @description Tap-to-run automations (Phase H). Skills are markdown files on
 * disk (server/lib/skills/store.js) - this page is a mobile-first tap-target
 * grid (the "tap a skill on my phone" surface the plan calls for), a run sheet
 * for params + safety confirmation, live step progress on recent runs, and a
 * raw markdown editor for creating/editing skill files (same file-first
 * philosophy as the Notes page: no bespoke form builder).
 *
 * A `phone` step's push notification deep-links here with `?phoneRun=<runId>`
 * - iOS gives no way to fire a Shortcut directly from a background push, so
 * the tap opens this page, which renders a plain `<a href="shortcuts://…">`
 * link (a real link tap is what iOS honors for a custom-scheme hand-off).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Zap,
  Plus,
  Play,
  Pencil,
  Trash2,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  Clock,
  Sun,
  Moon,
  Bell,
  Terminal,
  Bot,
  Sparkles,
  CalendarClock,
  Smartphone,
  AlertCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { EmptyState } from "../components/EmptyState";
import { eventBus } from "../lib/eventBus";
import { timeAgo, truncate } from "../lib/format";
import type { Skill, SkillRun, SkillRunStep, WSMessage } from "../lib/types";

const ICONS: Record<string, LucideIcon> = {
  sun: Sun,
  moon: Moon,
  bell: Bell,
  terminal: Terminal,
  bot: Bot,
  sparkles: Sparkles,
  calendar: CalendarClock,
  phone: Smartphone,
};

function skillIcon(name: string | null): LucideIcon {
  if (name && ICONS[name.toLowerCase()]) return ICONS[name.toLowerCase()] as LucideIcon;
  return Zap;
}

const CONFIRM_BADGE: Record<Skill["confirm"], { label: string; cls: string }> = {
  none: { label: "Tap to run", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25" },
  tap: { label: "Confirm", cls: "text-amber-300 bg-amber-500/10 border-amber-500/25" },
  typed: { label: "Typed confirm", cls: "text-red-300 bg-red-500/10 border-red-500/25" },
};

const RUN_WS_TYPES = new Set([
  "skill_run_started",
  "skill_run_step",
  "skill_run_finished",
  "skill_run_failed",
]);

const TEMPLATE = `---
name: New Skill
icon: sparkles
description: What this skill does
confirm: tap
steps:
  - type: notify
    message: "Hello from {name}!"
---
`;

export function Skills() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<Skill | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [skillsRes, runsRes] = await Promise.all([api.skills.list(), api.skills.runs.list()]);
      setSkills(skillsRes.items);
      setRuns(runsRes.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (RUN_WS_TYPES.has(msg.type) || msg.type === "skill_changed") load();
    });
  }, [load]);

  const phoneRunId = searchParams.get("phoneRun");
  const phoneRun = useMemo(() => runs.find((r) => r.id === phoneRunId) || null, [runs, phoneRunId]);

  const dismissPhoneRun = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("phoneRun");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
            <Zap className="w-5 h-5 text-accent" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-gray-50 tracking-tight">Skills</h1>
            <p className="text-xs text-gray-500">
              Tap-to-run automations - shell, agent, brain, and notify steps.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New skill
        </button>
      </header>

      {phoneRun && <PhoneHandoff run={phoneRun} onDismiss={dismissPhoneRun} />}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : skills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No skills yet"
          description="Skills are markdown files in your Skills folder - create one here, or drop a .md file in the folder directly."
          action={
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New skill
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {skills.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              onRun={() => setRunTarget(s)}
              onEdit={() => setEditing(s)}
            />
          ))}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-500">No runs yet.</p>
        ) : (
          <ul className="space-y-2">
            {runs.slice(0, 20).map((r) => (
              <RunRow key={r.id} run={r} onChanged={load} />
            ))}
          </ul>
        )}
      </section>

      {runTarget && (
        <RunSheet
          skill={runTarget}
          onClose={() => setRunTarget(null)}
          onRun={() => {
            setRunTarget(null);
            load();
          }}
        />
      )}

      {editing && (
        <EditorSheet
          skill={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onDeleted={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PhoneHandoff({ run, onDismiss }: { run: SkillRun; onDismiss: () => void }) {
  const phoneStep = run.steps.find((s) => s.type === "phone" && s.output);
  let shortcut = "";
  let message = "";
  if (phoneStep?.output) {
    try {
      const parsed = JSON.parse(phoneStep.output) as { shortcut?: string; message?: string };
      shortcut = parsed.shortcut || "";
      message = parsed.message || "";
    } catch {
      /* malformed - fall back to the raw output as the shortcut name */
      shortcut = phoneStep.output;
    }
  }
  const href = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcut)}`;

  return (
    <div className="card p-4 border-accent/30 bg-accent/5 flex items-center gap-4">
      <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center flex-shrink-0">
        <Smartphone className="w-5 h-5 text-accent" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-100">{run.skill_name}</p>
        <p className="text-xs text-gray-400 truncate">
          {message || `Hand off to the "${shortcut}" Shortcut.`}
        </p>
      </div>
      {shortcut && (
        <a
          href={href}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors flex-shrink-0"
        >
          Open Shortcuts
        </a>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-surface-4 transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function SkillCard({
  skill,
  onRun,
  onEdit,
}: {
  skill: Skill;
  onRun: () => void;
  onEdit: () => void;
}) {
  const Icon = skillIcon(skill.icon);
  const badge = CONFIRM_BADGE[skill.confirm];
  return (
    <div className="card p-4 flex flex-col gap-3 relative group">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${skill.name}`}
        className="absolute top-2 right-2 p-1.5 rounded-lg text-gray-600 hover:text-gray-200 hover:bg-surface-4 transition-colors opacity-0 group-hover:opacity-100"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onRun}
        disabled={!skill.valid}
        className="flex flex-col items-center gap-2 text-center disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="w-12 h-12 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
          <Icon className="w-6 h-6 text-accent" />
        </span>
        <span className="text-sm font-medium text-gray-100 leading-tight">{skill.name}</span>
        <span className="text-[11px] text-gray-500 line-clamp-2">{skill.description}</span>
      </button>
      <div className="flex items-center justify-center gap-1.5 flex-wrap">
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.cls}`}>
          {badge.label}
        </span>
        {skill.schedule && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border text-sky-300 bg-sky-500/10 border-sky-500/25">
            <CalendarClock className="w-2.5 h-2.5" />
            scheduled
          </span>
        )}
        {!skill.valid && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border text-red-300 bg-red-500/10 border-red-500/25">
            invalid
          </span>
        )}
      </div>
    </div>
  );
}

const STEP_ICON: Record<SkillRunStep["status"], LucideIcon> = {
  pending: Clock,
  running: Loader2,
  success: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
};

const RUN_STATUS_STYLES: Record<SkillRun["status"], string> = {
  running: "text-sky-300 bg-sky-500/10 border-sky-500/25",
  success: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25",
  failed: "text-red-300 bg-red-500/10 border-red-500/25",
  cancelled: "text-slate-400 bg-slate-500/10 border-slate-500/25",
};

function RunRow({ run, onChanged }: { run: SkillRun; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(run.status === "running");
  const [cancelling, setCancelling] = useState(false);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await api.skills.runs.cancel(run.id);
      onChanged();
    } finally {
      setCancelling(false);
    }
  }, [run.id, onChanged]);

  return (
    <li className="card px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${RUN_STATUS_STYLES[run.status]}`}
            >
              {run.status === "running" && <Loader2 className="w-3 h-3 animate-spin" />}
              {run.status}
            </span>
            <span className="text-sm font-medium text-gray-100 truncate">{run.skill_name}</span>
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">{run.trigger}</span>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">{timeAgo(run.started_at)}</p>
        </div>
        {run.status === "running" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              cancel();
            }}
            disabled={cancelling}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-300 bg-red-500/10 border border-red-500/25 hover:bg-red-500/20 transition-colors disabled:opacity-60 flex-shrink-0"
          >
            Cancel
          </button>
        )}
      </button>
      {expanded && (
        <ol className="mt-3 space-y-1.5 border-t border-border pt-3">
          {run.steps.map((s) => {
            const StepIcon = STEP_ICON[s.status];
            return (
              <li key={s.index} className="flex items-start gap-2 text-xs">
                <StepIcon
                  className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${
                    s.status === "running" ? "animate-spin text-sky-400" : ""
                  } ${s.status === "success" ? "text-emerald-400" : ""} ${
                    s.status === "failed" ? "text-red-400" : ""
                  } ${s.status === "cancelled" ? "text-gray-500" : ""} ${
                    s.status === "pending" ? "text-gray-600" : ""
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-gray-300">{s.label}</p>
                  {s.output && (
                    <p className="text-gray-500 font-mono break-words">{truncate(s.output, 200)}</p>
                  )}
                  {s.error && <p className="text-red-400 break-words">{s.error}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {run.error && <p className="mt-2 text-[11px] text-red-400 break-words">{run.error}</p>}
    </li>
  );
}

function RunSheet({
  skill,
  onClose,
  onRun,
}: {
  skill: Skill;
  onClose: () => void;
  onRun: () => void;
}) {
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      skill.params.map((p) => [p.name, p.default != null ? String(p.default) : ""])
    )
  );
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsTyped = skill.confirm === "typed";
  const canSubmit =
    !needsTyped || confirmText.trim().toLowerCase() === skill.name.trim().toLowerCase();

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.skills.run(skill.id, { params, confirmText: needsTyped ? confirmText : undefined });
      onRun();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run skill");
    } finally {
      setSubmitting(false);
    }
  }, [skill, params, confirmText, needsTyped, onRun]);

  return (
    <Modal onClose={onClose} title={`Run "${skill.name}"`} icon={skillIcon(skill.icon)}>
      <div className="space-y-3">
        {skill.params.map((p) => (
          <div key={p.name}>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {p.label || p.name}
            </label>
            <input
              value={params[p.name] ?? ""}
              onChange={(e) => setParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
              className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 focus:border-accent/50 focus:outline-none"
            />
          </div>
        ))}
        {needsTyped && (
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Type <span className="font-mono text-gray-200">{skill.name}</span> to confirm
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full rounded-lg bg-surface-2 border border-red-500/30 px-3 py-2 text-sm text-gray-100 focus:border-red-500/60 focus:outline-none"
            />
          </div>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-3 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            {submitting ? "Starting…" : "Run"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditorSheet({
  skill,
  onClose,
  onSaved,
  onDeleted,
}: {
  skill: Skill | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [raw, setRaw] = useState(skill?.raw ?? TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (skill) {
      api.skills
        .get(skill.id)
        .then((res) => setRaw(res.skill.raw ?? ""))
        .catch(() => {});
    }
  }, [skill]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (skill) await api.skills.update(skill.id, raw);
      else await api.skills.create(raw);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save skill");
    } finally {
      setSaving(false);
    }
  }, [skill, raw, onSaved]);

  const remove = useCallback(async () => {
    if (!skill) return;
    if (!window.confirm(`Delete "${skill.name}"? This removes its file.`)) return;
    setSaving(true);
    try {
      await api.skills.remove(skill.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete skill");
      setSaving(false);
    }
  }, [skill, onDeleted]);

  return (
    <Modal
      onClose={onClose}
      title={skill ? `Edit "${skill.name}"` : "New skill"}
      icon={Pencil}
      wide
    >
      <div className="space-y-3">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs font-mono text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none resize-y"
        />
        {skill && !skill.valid && <p className="text-xs text-red-300">{skill.errors.join("; ")}</p>}
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          {skill ? (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-3 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !raw.trim()}
              className="px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  icon: Icon,
  onClose,
  children,
  wide,
}: {
  title: string;
  icon: LucideIcon;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} card shadow-2xl animate-slide-up overflow-hidden`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-accent flex-shrink-0" />
            <h2 className="text-sm font-semibold text-gray-100 truncate">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 -m-1 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-surface-4 transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-4 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
