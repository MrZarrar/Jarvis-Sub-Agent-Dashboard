/**
 * @file Scheduled.tsx
 * @description Scheduled & chained prompts (Phase L). Lists pending / fired /
 * cancelled / failed schedules and lets the user queue a new one - either at a
 * wall-clock time or on completion of an existing mission. Live-updates from the
 * `schedule_*` WebSocket events. Cancelling a pending schedule offers a
 * cancel-cascade so its chained dependents go with it.
 *
 * This is the standalone panel the plan calls for; the Run page's "Queue
 * follow-up" action posts to the same /api/schedules surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Clock,
  CalendarClock,
  Link2,
  Play,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Ban,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type {
  MissionDomain,
  Mission,
  MissionModelTier,
  ScheduledPrompt,
  ScheduleStatus,
  WSMessage,
} from "../lib/types";
import { formatDateTime, timeAgo, truncate } from "../lib/format";

const SCHEDULE_WS_TYPES = new Set([
  "schedule_created",
  "schedule_updated",
  "schedule_cancelled",
  "schedule_fired",
  "schedule_failed",
]);

const STATUS_STYLES: Record<ScheduleStatus, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "text-amber-300 bg-amber-500/10 border-amber-500/25" },
  fired: { label: "Fired", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25" },
  cancelled: { label: "Cancelled", cls: "text-slate-400 bg-slate-500/10 border-slate-500/25" },
  failed: { label: "Failed", cls: "text-red-300 bg-red-500/10 border-red-500/25" },
};

const FILTERS: Array<{ key: ScheduleStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "fired", label: "Fired" },
  { key: "failed", label: "Failed" },
  { key: "cancelled", label: "Cancelled" },
];

export function Scheduled() {
  const [items, setItems] = useState<ScheduledPrompt[]>([]);
  const [filter, setFilter] = useState<ScheduleStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.schedules.list(filter === "all" ? undefined : filter);
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Live refresh on any schedule_* event.
  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (SCHEDULE_WS_TYPES.has(msg.type)) load();
    });
  }, [load]);

  const onCancel = useCallback(
    async (id: string) => {
      const cascade = window.confirm(
        "Also cancel follow-up schedules chained to this one?\n\nOK = this schedule and follow-ups\nCancel = this schedule only"
      );
      try {
        await api.schedules.cancel(id, cascade);
        load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to cancel");
      }
    },
    [load]
  );

  const pendingCount = useMemo(() => items.filter((i) => i.status === "pending").length, [items]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <header className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
          <CalendarClock className="w-5 h-5 text-accent" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-gray-50 tracking-tight">Scheduled missions</h1>
          <p className="text-xs text-gray-500">
            Run one-time or recurring missions through the same policy, permissions, and timeline.
            {pendingCount > 0 && ` · ${pendingCount} pending`}
          </p>
        </div>
      </header>

      <NewScheduleForm onCreated={load} />

      <div className="flex items-center gap-2 flex-wrap">
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
        <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border rounded-xl">
          <Clock className="w-8 h-8 text-gray-600 mx-auto mb-2" />
          <p className="text-sm text-gray-400">
            No schedules{filter !== "all" ? ` (${filter})` : ""} yet.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onCancel={onCancel} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule: s,
  onCancel,
}: {
  schedule: ScheduledPrompt;
  onCancel: (id: string) => void;
}) {
  const st = STATUS_STYLES[s.status];
  const StatusIcon =
    s.status === "fired"
      ? CheckCircle2
      : s.status === "failed"
        ? AlertCircle
        : s.status === "cancelled"
          ? Ban
          : Clock;

  return (
    <li className="card px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${st.cls}`}
            >
              <StatusIcon className="w-3 h-3" />
              {st.label}
            </span>
            {s.late === 1 && (
              <span className="text-[10px] text-amber-400 font-medium uppercase tracking-wide">
                late
              </span>
            )}
            {s.label && (
              <span className="text-sm font-medium text-gray-100 truncate">{s.label}</span>
            )}
          </div>

          <p className="mt-1.5 text-sm text-gray-300 font-mono break-words">
            {truncate(s.prompt, 220)}
          </p>

          <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] text-gray-500">
            <span className="inline-flex items-center gap-1">
              {s.trigger_kind === "at" ? (
                <>
                  <CalendarClock className="w-3 h-3" />
                  {s.fire_at ? formatDateTime(s.fire_at) : "-"}
                </>
              ) : (
                <>
                  <Link2 className="w-3 h-3" />
                  on run{" "}
                  {s.trigger_run_id ? (
                    <Link
                      className="text-accent hover:underline"
                      to={`/run?runId=${encodeURIComponent(s.trigger_run_id)}`}
                    >
                      {s.trigger_run_id.slice(0, 8)}
                    </Link>
                  ) : (
                    "?"
                  )}{" "}
                  {s.status_filter === "success" ? "succeeds" : "completes"}
                </>
              )}
            </span>
            <span className="inline-flex items-center gap-1">
              <Play className="w-3 h-3" />
              {s.target_kind === "mission"
                ? `${s.domain} mission · ${s.thread_strategy.replace(/_/g, " ")}`
                : s.target_kind === "new_run"
                  ? "legacy run"
                  : "follow-up message"}
            </span>
            {s.recurrence && <span>{s.recurrence.replace("RRULE:", "")}</span>}
            <span>
              {s.overlap_policy} overlap · {s.missed_run_policy} missed · {s.timeout_seconds}s
              timeout
            </span>
            {s.retry_limit > 0 && (
              <span>
                retry {s.retry_attempts}/{s.retry_limit}
              </span>
            )}
            {s.result_run_id && (
              <Link
                className="text-accent hover:underline"
                to={
                  s.target_kind === "mission"
                    ? `/missions/${encodeURIComponent(s.result_run_id)}`
                    : `/run?runId=${encodeURIComponent(s.result_run_id)}`
                }
              >
                → {s.target_kind === "mission" ? "mission" : "run"} {s.result_run_id.slice(0, 8)}
              </Link>
            )}
            <span>created {timeAgo(s.created_at)}</span>
          </div>

          {s.error && <p className="mt-1.5 text-[11px] text-red-400 break-words">{s.error}</p>}
        </div>

        {s.status === "pending" && (
          <button
            type="button"
            onClick={() => onCancel(s.id)}
            title="Cancel schedule"
            className="p-2 rounded-lg text-gray-500 hover:text-red-300 hover:bg-red-500/10 transition-colors flex-shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Create form - supports both trigger kinds. For 'at' the user picks a
 *  datetime; for 'on_run_complete' they pick a mission to chain after. */
function NewScheduleForm({ onCreated }: { onCreated: () => void }) {
  const [triggerKind, setTriggerKind] = useState<"at" | "on_run_complete">("at");
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState("");
  const [fireAt, setFireAt] = useState("");
  const [cwd, setCwd] = useState("");
  const [triggerRunId, setTriggerRunId] = useState("");
  const [successOnly, setSuccessOnly] = useState(false);
  const [domain, setDomain] = useState<MissionDomain>("personal");
  const [modelTier, setModelTier] = useState<MissionModelTier | "auto">("auto");
  const [repeat, setRepeat] = useState<"once" | "hourly" | "daily" | "weekly">("once");
  const [threadStrategy, setThreadStrategy] = useState<
    "new_thread" | "resume_thread" | "steer_active"
  >("new_thread");
  const [sandboxPolicy, setSandboxPolicy] = useState<"read-only" | "workspace-write">("read-only");
  const [overlapPolicy, setOverlapPolicy] = useState<"skip" | "queue" | "cancel_previous">("skip");
  const [missedRunPolicy, setMissedRunPolicy] = useState<"run_once" | "skip">("run_once");
  const [retryLimit, setRetryLimit] = useState(1);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.missions
      .list()
      .then((result) => setMissions(result.items))
      .catch(() => setMissions([]));
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!prompt.trim()) {
        setError("Prompt is required");
        return;
      }
      setSubmitting(true);
      try {
        await api.schedules.create({
          label: label.trim() || null,
          prompt,
          targetKind: "mission",
          targetOpts: cwd.trim() ? { cwd: cwd.trim() } : {},
          triggerKind,
          fireAt: triggerKind === "at" ? new Date(fireAt).toISOString() : undefined,
          triggerRunId: triggerKind === "on_run_complete" ? triggerRunId : undefined,
          statusFilter: successOnly ? "success" : "any",
          recurrence: repeat === "once" ? null : `RRULE:FREQ=${repeat.toUpperCase()};INTERVAL=1`,
          domain,
          modelTier: modelTier === "auto" ? null : modelTier,
          workspace: cwd.trim() || null,
          approvalPolicy: "never",
          sandboxPolicy,
          threadStrategy,
          overlapPolicy,
          missedRunPolicy,
          retryLimit,
          timeoutSeconds: Math.max(1, timeoutMinutes) * 60,
          notificationPolicy: "all",
        });
        setPrompt("");
        setLabel("");
        setFireAt("");
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to schedule");
      } finally {
        setSubmitting(false);
      }
    },
    [
      prompt,
      label,
      cwd,
      triggerKind,
      fireAt,
      triggerRunId,
      successOnly,
      repeat,
      domain,
      modelTier,
      threadStrategy,
      sandboxPolicy,
      overlapPolicy,
      missedRunPolicy,
      retryLimit,
      timeoutMinutes,
      onCreated,
    ]
  );

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTriggerKind("at")}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            triggerKind === "at"
              ? "bg-accent/15 text-accent border-accent/30"
              : "bg-surface-2 text-gray-400 border-border hover:text-gray-200"
          }`}
        >
          At a time
        </button>
        <button
          type="button"
          onClick={() => setTriggerKind("on_run_complete")}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            triggerKind === "on_run_complete"
              ? "bg-accent/15 text-accent border-accent/30"
              : "bg-surface-2 text-gray-400 border-border hover:text-gray-200"
          }`}
        >
          After a mission
        </button>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should this mission accomplish? For follow-ups, {status} contains the prior mission result."
        rows={3}
        className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none resize-y font-mono"
      />

      <details className="rounded-xl border border-border bg-surface-2/30 p-3">
        <summary className="cursor-pointer select-none text-xs font-medium text-gray-400">
          Advanced execution policy
        </summary>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value as MissionDomain)}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
          >
            <option value="personal">Personal · Codex</option>
            <option value="development">Development · GPT-5.6 Sol + Claude team</option>
            <option value="business">Business · Codex</option>
            <option value="generic">Generic · policy selected</option>
          </select>
          <select
            value={modelTier}
            onChange={(e) => setModelTier(e.target.value as MissionModelTier | "auto")}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
          >
            <option value="auto">Auto model tier</option>
            <option value="fast">Fast</option>
            <option value="standard">Standard</option>
            <option value="executor">Executor</option>
            <option value="deep_review">Deep review</option>
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none"
          />
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="Working directory (optional - absolute path)"
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none font-mono"
          />

          {triggerKind === "at" ? (
            <>
              <input
                type="datetime-local"
                value={fireAt}
                onChange={(e) => setFireAt(e.target.value)}
                required
                className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 focus:border-accent/50 focus:outline-none"
              />
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as typeof repeat)}
                className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
              >
                <option value="once">Run once</option>
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </>
          ) : (
            <select
              value={triggerRunId}
              onChange={(e) => setTriggerRunId(e.target.value)}
              required
              className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 focus:border-accent/50 focus:outline-none"
            >
              <option value="">Select a mission to chain after…</option>
              {missions.map((mission) => (
                <option key={mission.id} value={mission.id}>
                  {mission.title} · {mission.status} · {truncate(mission.prompt || "", 40)}
                </option>
              ))}
            </select>
          )}

          {triggerKind === "on_run_complete" && (
            <label className="flex items-center gap-2 text-xs text-gray-400 px-1">
              <input
                type="checkbox"
                checked={successOnly}
                onChange={(e) => setSuccessOnly(e.target.checked)}
                className="accent-accent"
              />
              Only fire if the mission succeeds
            </label>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <select
            value={threadStrategy}
            onChange={(e) => setThreadStrategy(e.target.value as typeof threadStrategy)}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
          >
            <option value="new_thread">New thread each run</option>
            <option value="resume_thread">Resume prior thread</option>
            <option value="steer_active">Steer active thread</option>
          </select>
          <select
            value={sandboxPolicy}
            onChange={(e) => setSandboxPolicy(e.target.value as typeof sandboxPolicy)}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
          >
            <option value="read-only">Read-only sandbox (recommended)</option>
            <option value="workspace-write">Allow workspace writes</option>
          </select>
        </div>

        <p
          className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${sandboxPolicy === "workspace-write" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-border text-gray-500"}`}
        >
          Unattended missions cannot request fresh approval. Workspace-write is an explicit grant
          for this schedule; otherwise unsafe work pauses without broadening access.
        </p>

        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <select
            value={overlapPolicy}
            onChange={(e) => setOverlapPolicy(e.target.value as typeof overlapPolicy)}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-100"
          >
            <option value="skip">Overlap: skip</option>
            <option value="queue">Overlap: queue</option>
            <option value="cancel_previous">Cancel previous</option>
          </select>
          <select
            value={missedRunPolicy}
            onChange={(e) => setMissedRunPolicy(e.target.value as typeof missedRunPolicy)}
            className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-100"
          >
            <option value="run_once">Missed: run once</option>
            <option value="skip">Missed: skip</option>
          </select>
          <label className="text-[10px] text-gray-500">
            Launch retries
            <input
              type="number"
              min={0}
              max={5}
              value={retryLimit}
              onChange={(e) => setRetryLimit(Number(e.target.value))}
              className="mt-1 w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-100"
            />
          </label>
          <label className="text-[10px] text-gray-500">
            Timeout minutes
            <input
              type="number"
              min={1}
              max={1440}
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
              className="mt-1 w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-100"
            />
          </label>
        </div>
      </details>

      {error && (
        <p className="text-xs text-red-300 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-60"
        >
          <CalendarClock className="w-4 h-4" />
          {submitting ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </form>
  );
}
