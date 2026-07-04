/**
 * @file Briefings.tsx
 * @description Proactive Jarvis (Phase J): the briefings history + on-demand
 * "run now", plus the Phase-J config (briefing times, deterministic nudge rules,
 * and the JARVIS personality toggle). The scheduled morning/evening briefings,
 * the "morning briefing" voice intent, and this page's "Run now" all post to the
 * same /api/briefings surface. Live-updates on the `briefing_created` WS event.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Sunrise, Moon, Play, AlertCircle, Bot, Bell, Settings2 } from "lucide-react";
import { api } from "../lib/api";
import type { Briefing, BriefingKind, ProactiveConfig, WSMessage } from "../lib/types";
import { eventBus } from "../lib/eventBus";
import { timeAgo } from "../lib/format";
import { MarkdownContent } from "../components/conversation/MarkdownContent";

export function Briefings() {
  const [items, setItems] = useState<Briefing[]>([]);
  const [config, setConfig] = useState<ProactiveConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<BriefingKind | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.briefings.list(30), api.briefings.config()]);
      setItems(list.items);
      setConfig(cfg.config);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load briefings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live refresh when a scheduled / voice briefing lands.
  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "briefing_created") load();
    });
  }, [load]);

  const runNow = useCallback(
    async (kind: BriefingKind) => {
      setRunning(kind);
      setError(null);
      try {
        await api.briefings.run(kind);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to compose briefing");
      } finally {
        setRunning(null);
      }
    },
    [load]
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <header className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-accent" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-gray-50 tracking-tight">Briefings</h1>
          <p className="text-xs text-gray-500">
            Jarvis composes a morning briefing and an end-of-day summary from your projects, GitHub,
            and run activity - on a schedule, on demand, or by voice.
          </p>
        </div>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => runNow("morning")}
          disabled={running !== null}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-60"
        >
          <Sunrise className="w-4 h-4" />
          {running === "morning" ? "Composing…" : "Run morning briefing"}
        </button>
        <button
          type="button"
          onClick={() => runNow("evening")}
          disabled={running !== null}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 text-gray-200 border border-border text-sm font-medium hover:bg-surface-3 transition-colors disabled:opacity-60"
        >
          <Moon className="w-4 h-4" />
          {running === "evening" ? "Composing…" : "Run end-of-day summary"}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {config && <ProactiveSettings config={config} onSaved={setConfig} />}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">Recent briefings</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-border rounded-xl">
            <Sparkles className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-400">
              No briefings yet. Run one above, or wait for the next scheduled time.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((b) => (
              <BriefingCard key={b.id} briefing={b} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BriefingCard({ briefing: b }: { briefing: Briefing }) {
  const Icon = b.kind === "morning" ? Sunrise : Moon;
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border text-accent bg-accent/10 border-accent/25">
          <Icon className="w-3 h-3" />
          {b.kind === "morning" ? "Morning" : "End of day"}
        </span>
        {b.trigger && (
          <span className="text-[10px] uppercase tracking-wide text-gray-500">{b.trigger}</span>
        )}
        <span className="text-[11px] text-gray-500">
          {b.provider ? `via ${b.provider}` : "composed locally"}
        </span>
        <span className="text-[11px] text-gray-500 ml-auto">{timeAgo(b.created_at)}</span>
      </div>
      <div className="text-sm text-gray-200">
        <MarkdownContent text={b.text} dense />
      </div>
      {b.note_id && (
        <div className="mt-2">
          <Link className="text-[11px] text-accent hover:underline" to="/notes">
            Filed as a note →
          </Link>
        </div>
      )}
    </li>
  );
}

/** Phase-J config: briefing times, nudge rules, and the JARVIS persona toggle. */
function ProactiveSettings({
  config,
  onSaved,
}: {
  config: ProactiveConfig;
  onSaved: (c: ProactiveConfig) => void;
}) {
  const [draft, setDraft] = useState<ProactiveConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(config), [config]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.briefings.updateConfig(draft);
      onSaved(res.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  return (
    <details className="card p-4">
      <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-200 select-none">
        <Settings2 className="w-4 h-4 text-gray-400" />
        Schedule, nudges &amp; personality
      </summary>

      <div className="mt-4 space-y-4">
        {/* Persona */}
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={draft.persona}
            onChange={(e) => setDraft({ ...draft, persona: e.target.checked })}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm text-gray-100">
              <Bot className="w-3.5 h-3.5 text-accent" /> JARVIS personality
            </span>
            <span className="block text-xs text-gray-500">
              Dry, formal-but-warm butler voice (calls you “sir”). Off = neutral phrasing.
            </span>
          </span>
        </label>

        {/* Briefing schedules */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ScheduleField
            icon={<Sunrise className="w-3.5 h-3.5 text-accent" />}
            label="Morning briefing"
            enabled={draft.morning.enabled}
            time={draft.morning.time}
            onEnabled={(v) => setDraft({ ...draft, morning: { ...draft.morning, enabled: v } })}
            onTime={(v) => setDraft({ ...draft, morning: { ...draft.morning, time: v } })}
          />
          <ScheduleField
            icon={<Moon className="w-3.5 h-3.5 text-accent" />}
            label="End-of-day summary"
            enabled={draft.evening.enabled}
            time={draft.evening.time}
            onEnabled={(v) => setDraft({ ...draft, evening: { ...draft.evening, enabled: v } })}
            onTime={(v) => setDraft({ ...draft, evening: { ...draft.evening, time: v } })}
          />
        </div>

        {/* Nudges */}
        <div className="space-y-2">
          <span className="flex items-center gap-1.5 text-sm text-gray-200">
            <Bell className="w-3.5 h-3.5 text-gray-400" /> Nudges
          </span>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={draft.nudges.runFailed}
              onChange={(e) =>
                setDraft({ ...draft, nudges: { ...draft.nudges, runFailed: e.target.checked } })
              }
              className="accent-accent"
            />
            Push when a run fails
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400 flex-wrap">
            <input
              type="checkbox"
              checked={draft.nudges.waitingAgents}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  nudges: { ...draft.nudges, waitingAgents: e.target.checked },
                })
              }
              className="accent-accent"
            />
            Push when an agent waits longer than
            <input
              type="number"
              min={1}
              max={240}
              value={draft.nudges.waitingMinutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  nudges: { ...draft.nudges, waitingMinutes: Number(e.target.value) || 1 },
                })
              }
              className="w-16 rounded-md bg-surface-2 border border-border px-2 py-1 text-xs text-gray-100 focus:border-accent/50 focus:outline-none"
            />
            minutes
          </label>
          <p className="text-[11px] text-gray-600">
            Nudges respect your{" "}
            <Link to="/settings" className="text-accent hover:underline">
              notification categories
            </Link>
            . Neglected projects are mentioned in briefings, not pushed instantly.
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-300 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors disabled:opacity-60"
          >
            <Play className="w-3.5 h-3.5" />
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-xs text-emerald-400">Saved.</span>}
        </div>
      </div>
    </details>
  );
}

function ScheduleField({
  icon,
  label,
  enabled,
  time,
  onEnabled,
  onTime,
}: {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  time: string;
  onEnabled: (v: boolean) => void;
  onTime: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
      <label className="flex items-center gap-2 text-sm text-gray-100">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
          className="accent-accent"
        />
        {icon}
        {label}
      </label>
      <input
        type="time"
        value={time}
        disabled={!enabled}
        onChange={(e) => onTime(e.target.value)}
        className="rounded-md bg-surface-3 border border-border px-2 py-1 text-sm text-gray-100 focus:border-accent/50 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
