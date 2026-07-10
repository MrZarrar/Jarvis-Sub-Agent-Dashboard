/**
 * @file MondayPanel.tsx
 * @description Full Monday.com page (Phase AD) - a deliberate clone of
 * GitHubPanel.tsx: a due lane (overdue + due today), items assigned to me
 * grouped by board, recent activity, plus an inline config editor (personal API
 * token + done label + poll cadence). All Monday calls are server-side; the
 * token is never shipped to the client (only a `hasToken` boolean).
 *
 * Items can be marked done from here (the AD write-back minimum) - the same
 * endpoint the Today board (Phase AC) checks Monday items with.
 *
 * Loads the cached overview on mount, live-updates on `monday_updated`, and
 * degrades safely if the WS event is delayed.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ClipboardList,
  CalendarClock,
  CircleAlert,
  RefreshCw,
  Settings2,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { MondayConfig, MondayItem, MondayOverviewResponse, WSMessage } from "../lib/types";
import { timeAgo } from "../lib/format";

function ItemRow({
  item,
  onDone,
  marking,
}: {
  item: MondayItem;
  onDone: (item: MondayItem) => void;
  marking: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-3/60 transition-colors group">
      {item.statusColumnId && !item.done && (
        <button
          className="flex-shrink-0 text-gray-600 hover:text-emerald-400 transition-colors disabled:opacity-50"
          title="Mark done"
          disabled={marking}
          onClick={() => onDone(item)}
        >
          <CheckCircle2 className="w-4 h-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-gray-100 truncate">{item.name}</span>
          {item.status && <span className="badge text-[10px]">{item.status}</span>}
        </div>
        <div className="text-[11px] text-gray-500 truncate">
          {item.boardName}
          {item.group ? ` · ${item.group}` : ""}
          {item.dueDate ? ` · due ${item.dueDate}` : ""}
          {item.updatedAt ? ` · ${timeAgo(item.updatedAt)}` : ""}
        </div>
      </div>
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer" className="flex-shrink-0">
          <ExternalLink className="w-3.5 h-3.5 text-gray-600 group-hover:text-accent" />
        </a>
      )}
    </div>
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

function ConfigEditor({ config, onSaved }: { config: MondayConfig; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [doneLabel, setDoneLabel] = useState(config.doneLabel);
  const [pollMinutes, setPollMinutes] = useState(config.pollMinutes);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (patch: Parameters<typeof api.monday.updateConfig>[0]) => {
    setSaving(true);
    setMsg(null);
    try {
      await api.monday.updateConfig(patch);
      setToken("");
      setMsg("Saved");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
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
          Personal API token {config.hasToken ? "(set - leave blank to keep)" : ""}
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            className="input flex-1 font-mono text-sm"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={config.hasToken ? "••••••••" : "eyJ…"}
          />
          <button
            className="btn-secondary text-xs"
            disabled={saving || !token}
            onClick={() => save({ token })}
          >
            Save token
          </button>
          {config.hasToken && (
            <button
              className="btn-secondary text-xs"
              disabled={saving}
              onClick={() => save({ token: "" })}
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          monday.com → your avatar → Developers → My access tokens. Works on the free plan; the
          token never leaves this server.
        </p>
      </div>

      <div className="border-t border-border pt-4 flex items-end gap-2 flex-wrap">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Done status label</label>
          <input
            type="text"
            className="input w-32 text-sm"
            value={doneLabel}
            onChange={(e) => setDoneLabel(e.target.value)}
          />
        </div>
        <button
          className="btn-secondary text-xs"
          disabled={saving}
          onClick={() => save({ doneLabel })}
        >
          Save label
        </button>
        <span className="text-[11px] text-gray-500 ml-1 mb-1.5">
          "Mark done" writes this label to the item's status column.
        </span>
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

export function MondayPanel() {
  const [data, setData] = useState<MondayOverviewResponse | null>(null);
  const [config, setConfig] = useState<MondayConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, cfg] = await Promise.all([api.monday.overview(), api.monday.config()]);
      setData(ov);
      setConfig(cfg.config);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Monday data");
    }
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "monday_updated") load();
    });
  }, [load]);

  // Open the config editor by default when nothing is configured yet.
  useEffect(() => {
    if (config && (!config.enabled || !config.hasToken)) setShowConfig(true);
  }, [config]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const ov = await api.monday.refresh();
      setData(ov);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const markDone = async (item: MondayItem) => {
    setMarkingId(item.id);
    try {
      await api.monday.markDone(item.id, item.boardId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mark done failed");
    } finally {
      setMarkingId(null);
    }
  };

  const ov = data?.overview;

  // "My items" grouped by board for the board-shaped view the plan asks for.
  const mineByBoard = new Map<string, MondayItem[]>();
  for (const item of ov?.mine ?? []) {
    const list = mineByBoard.get(item.boardName) ?? [];
    list.push(item);
    mineByBoard.set(item.boardName, list);
  }

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center gap-3 flex-wrap">
        <ClipboardList className="w-6 h-6 text-accent" />
        <h1 className="text-xl font-semibold text-gray-100">Monday</h1>
        {ov?.me?.name && <span className="badge text-[10px]">{ov.me.name}</span>}
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
          Monday fetch problem: {ov.error}
        </div>
      )}

      {showConfig && config && <ConfigEditor config={config} onSaved={load} />}

      {data && !data.configured && !showConfig && (
        <div className="card p-6 text-center text-sm text-gray-400">
          No Monday token configured yet.{" "}
          <button className="text-accent underline" onClick={() => setShowConfig(true)}>
            Add your API token
          </button>{" "}
          to see your boards, items, and due dates.
        </div>
      )}

      {ov && data?.configured && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Section title="Overdue" count={ov.counts.overdue} empty="Nothing overdue - clean slate.">
            {ov.overdue.map((item) => (
              <ItemRow
                key={`${item.boardId}#${item.id}`}
                item={item}
                onDone={markDone}
                marking={markingId === item.id}
              />
            ))}
          </Section>

          <Section title="Due today" count={ov.counts.dueToday} empty="Nothing due today.">
            {ov.dueToday.map((item) => (
              <ItemRow
                key={`${item.boardId}#${item.id}`}
                item={item}
                onDone={markDone}
                marking={markingId === item.id}
              />
            ))}
          </Section>

          <Section title="Assigned to you" count={ov.counts.mine} empty="Nothing assigned to you.">
            {[...mineByBoard.entries()].map(([board, items]) => (
              <div key={board}>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 px-3 pt-2">
                  {board}
                </div>
                {items.map((item) => (
                  <ItemRow
                    key={`${item.boardId}#${item.id}`}
                    item={item}
                    onDone={markDone}
                    marking={markingId === item.id}
                  />
                ))}
              </div>
            ))}
          </Section>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-2">Summary</h2>
            <ul className="text-sm text-gray-400 space-y-1">
              <li className={ov.counts.overdue > 0 ? "text-red-400" : ""}>
                <CircleAlert className="w-3.5 h-3.5 inline mr-1" />
                {ov.counts.overdue} overdue item(s)
              </li>
              <li className={ov.counts.dueToday > 0 ? "text-amber-400" : ""}>
                <CalendarClock className="w-3.5 h-3.5 inline mr-1" />
                {ov.counts.dueToday} due today
              </li>
              <li>{ov.counts.mine} assigned to you</li>
              <li>{ov.counts.boards} board(s) watched</li>
            </ul>
            {ov.boards.length > 0 && (
              <p className="text-[11px] text-gray-600 mt-3 truncate">
                Boards: {ov.boards.map((b) => b.name).join(", ")}
              </p>
            )}
          </div>

          <div className="lg:col-span-2">
            <Section title="Recent activity" count={ov.recent.length} empty="No recent updates.">
              {ov.recent.map((item) => (
                <ItemRow
                  key={`recent-${item.boardId}#${item.id}`}
                  item={item}
                  onDone={markDone}
                  marking={markingId === item.id}
                />
              ))}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
