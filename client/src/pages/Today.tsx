/**
 * @file Today.tsx
 * @description Today board (Phase AC, revamped) - the "glance at my phone over
 * coffee" surface, restyled as a holographic mission board. Three lanes fed by
 * GET /api/today (server-side aggregation, no new storage):
 *   - Do today: open note todos, Monday items due/overdue, today's scheduled
 *     prompts, agents waiting on the user.
 *   - In flight: running dashboard runs + working-agent count.
 *   - Done today: runs completed/failed today, schedules fired today, and
 *     anything checked in this session.
 * Todos are full CRUD from this screen: quick-add writes a `- [ ]` line to
 * today's daily note (created on first add), edit/delete rewrite the line in
 * whichever note owns it - the markdown files stay the source of truth
 * (Obsidian sees every change). Checking a Monday item calls the Phase-AD
 * write-back. Agent/schedule rows deep-link - they don't complete from here.
 */

import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  ListTodo,
  RefreshCw,
  CalendarClock,
  ClipboardList,
  NotebookPen,
  Bot,
  Play,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { useWorkMode } from "../lib/workMode";
import { Checkbox } from "../components/Checkbox";
import type { MondayItem, TodayBoard, TodayTodo, WSMessage } from "../lib/types";
import { timeAgo } from "../lib/format";

const RELOAD_EVENTS = new Set([
  "note_changed",
  "monday_updated",
  "schedule_created",
  "schedule_updated",
  "schedule_cancelled",
  "schedule_fired",
  "run_status",
  "agent_updated",
]);

function Lane({
  title,
  count,
  accent,
  bootDelay,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  bootDelay: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="holo-panel hud-frame holo-boot p-4 flex flex-col gap-1 min-w-0"
      style={{ "--boot-delay": bootDelay } as React.CSSProperties}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="hud-label text-xs">{title}</h2>
        <span
          className="text-[11px] font-mono px-2 py-0.5 rounded-full border"
          style={{
            color: accent,
            borderColor: `${accent}44`,
            backgroundColor: `${accent}14`,
          }}
        >
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function RowMeta({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-gray-500 truncate">{children}</div>;
}

/** One editable note-todo row: check, inline edit, delete on hover. */
function TodoRow({
  todo,
  busy,
  onCheck,
  onEdit,
  onDelete,
}: {
  todo: TodayTodo;
  busy: boolean;
  onCheck: () => void;
  onEdit: (newText: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.text);

  const commit = async () => {
    const text = draft.trim();
    if (!text || text === todo.text) {
      setEditing(false);
      setDraft(todo.text);
      return;
    }
    await onEdit(text);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-2/60 border border-accent/30">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(todo.text);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-sm text-gray-100 outline-none"
        />
        <button
          onClick={commit}
          className="p-1 text-emerald-400 hover:text-emerald-300"
          aria-label="Save"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setDraft(todo.text);
          }}
          className="p-1 text-gray-500 hover:text-gray-300"
          aria-label="Cancel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-3/60 transition-colors">
      <Checkbox checked={false} onChange={onCheck} className={busy ? "opacity-50" : ""} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-100">{todo.text}</div>
        <RowMeta>
          <NotebookPen className="w-3 h-3 inline mr-1" />
          {todo.noteTitle}
        </RowMeta>
      </div>
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
        <button
          onClick={() => {
            setDraft(todo.text);
            setEditing(true);
          }}
          className="p-1 text-gray-500 hover:text-accent"
          aria-label="Edit task"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1 text-gray-500 hover:text-red-400"
          aria-label="Delete task"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Today() {
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Checked in this session - kept visible in the Done lane even after the
  // server-side reload drops them from the open lists.
  const [doneTodos, setDoneTodos] = useState<TodayTodo[]>([]);
  const [doneMonday, setDoneMonday] = useState<MondayItem[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const workMode = useWorkMode();

  const load = useCallback(async () => {
    try {
      setBoard(await api.today.board(workMode));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the board");
    }
  }, [workMode]);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (RELOAD_EVENTS.has(msg.type)) load();
    });
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const addTodo = async () => {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await api.today.addTodo({ text, mode: workMode });
      setNewText("");
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the task");
    } finally {
      setAdding(false);
    }
  };

  const removeTodoLocally = (todo: TodayTodo) =>
    setBoard((b) =>
      b
        ? {
            ...b,
            todos: b.todos.filter((t) => !(t.noteId === todo.noteId && t.line === todo.line)),
          }
        : b
    );

  const checkTodo = async (todo: TodayTodo) => {
    const key = `todo:${todo.noteId}:${todo.line}`;
    setBusyKey(key);
    try {
      await api.today.checkTodo({ noteId: todo.noteId, line: todo.line, text: todo.text });
      setDoneTodos((d) => [todo, ...d]);
      removeTodoLocally(todo);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the todo");
    } finally {
      setBusyKey(null);
    }
  };

  const editTodo = async (todo: TodayTodo, newTextValue: string) => {
    try {
      await api.today.editTodo({
        noteId: todo.noteId,
        line: todo.line,
        text: todo.text,
        newText: newTextValue,
      });
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not edit the task");
    }
  };

  const deleteTodo = async (todo: TodayTodo) => {
    try {
      await api.today.deleteTodo({ noteId: todo.noteId, line: todo.line, text: todo.text });
      removeTodoLocally(todo);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the task");
    }
  };

  const checkMonday = async (item: MondayItem) => {
    const key = `monday:${item.id}`;
    setBusyKey(key);
    try {
      await api.monday.markDone(item.id, item.boardId);
      setDoneMonday((d) => [item, ...d]);
      setBoard((b) =>
        b
          ? {
              ...b,
              monday: {
                ...b.monday,
                dueToday: b.monday.dueToday.filter((i) => i.id !== item.id),
                overdue: b.monday.overdue.filter((i) => i.id !== item.id),
              },
            }
          : b
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark the item done");
    } finally {
      setBusyKey(null);
    }
  };

  if (!board) {
    return (
      <div className="flex flex-col gap-6 animate-fade-in">
        <div className="flex items-center gap-3">
          <ListTodo className="w-6 h-6 text-accent" />
          <h1 className="text-xl font-semibold text-gray-100">Today</h1>
        </div>
        {error ? (
          <div className="card p-3 border-red-500/30 text-sm text-red-400">{error}</div>
        ) : (
          <div className="card p-6 text-center text-sm text-gray-500">Loading…</div>
        )}
      </div>
    );
  }

  const mondayDue = [...board.monday.overdue, ...board.monday.dueToday];
  const doCount =
    board.todos.length +
    mondayDue.length +
    board.schedules.pending.length +
    board.agents.waiting.length;
  const flightCount = board.runs.running.length + (board.agents.workingCount > 0 ? 1 : 0);
  const doneCount =
    doneTodos.length +
    doneMonday.length +
    board.runs.completedToday.length +
    board.runs.failedToday.length +
    board.schedules.firedToday.length;
  // Day progress: session-checked items vs everything actionable seen today.
  const progressTotal = doCount + doneCount;
  const progressPct = progressTotal > 0 ? Math.round((doneCount / progressTotal) * 100) : 0;

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center gap-3 flex-wrap">
        <ListTodo className="w-6 h-6 text-accent" />
        <h1 className="text-xl font-semibold text-gray-100">Today</h1>
        <span className="text-xs text-gray-500 font-mono">{board.date}</span>
        <div
          className="flex items-center gap-2 ml-2"
          title={`${doneCount} of ${progressTotal} done`}
        >
          <div className="w-28 h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-700"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-[11px] font-mono text-gray-500">{progressPct}%</span>
        </div>
        <button className="btn-secondary text-xs ml-auto" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`w-3.5 h-3.5 inline mr-1 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && <div className="card p-3 border-red-500/30 text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <Lane title="Do today" count={doCount} accent="#60a5fa" bootDelay="0.1s">
          {/* Quick add - writes a `- [ ]` line into today's daily note. */}
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded-lg bg-surface-2/40 border border-border/60 focus-within:border-accent/50 transition-colors">
            <Plus className="w-4 h-4 text-accent/70 flex-shrink-0" />
            <input
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTodo()}
              placeholder="Add a task…"
              className="flex-1 min-w-0 bg-transparent text-sm text-gray-100 placeholder-gray-600 outline-none"
              disabled={adding}
            />
            {newText.trim() && (
              <button
                onClick={addTodo}
                disabled={adding}
                className="text-[11px] text-accent hover:text-accent/80 font-medium flex-shrink-0"
              >
                Add
              </button>
            )}
          </div>
          {doCount === 0 && <p className="text-xs text-gray-500 px-1 py-1">Nothing here.</p>}
          {board.todos.map((todo) => (
            <TodoRow
              key={`${todo.noteId}:${todo.line}`}
              todo={todo}
              busy={busyKey === `todo:${todo.noteId}:${todo.line}`}
              onCheck={() => busyKey === null && checkTodo(todo)}
              onEdit={(text) => editTodo(todo, text)}
              onDelete={() => deleteTodo(todo)}
            />
          ))}
          {mondayDue.map((item) => (
            <div
              key={`monday:${item.id}`}
              className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-3/60 transition-colors"
            >
              <Checkbox
                checked={false}
                onChange={() => busyKey === null && item.statusColumnId && checkMonday(item)}
                className={busyKey === `monday:${item.id}` ? "opacity-50" : ""}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-100">{item.name}</div>
                <RowMeta>
                  <ClipboardList className="w-3 h-3 inline mr-1" />
                  {item.boardName}
                  {item.dueDate ? ` · due ${item.dueDate}` : ""}
                  {board.monday.overdue.some((i) => i.id === item.id) && (
                    <span className="text-red-400"> · overdue</span>
                  )}
                </RowMeta>
              </div>
            </div>
          ))}
          {board.schedules.pending.map((s) => (
            <NavLink
              key={s.id}
              to="/scheduled"
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <CalendarClock className="w-4 h-4 flex-shrink-0 text-accent/70 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-100 truncate">{s.label || s.prompt}</div>
                <RowMeta>scheduled{s.fireAt ? ` · ${timeAgo(s.fireAt)}` : ""}</RowMeta>
              </div>
            </NavLink>
          ))}
          {board.agents.waiting.map((a) => (
            <NavLink
              key={a.id}
              to={`/sessions/${encodeURIComponent(a.sessionId)}`}
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <Bot className="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-100 truncate">{a.name}</div>
                <RowMeta>waiting on you{a.task ? ` · ${a.task}` : ""}</RowMeta>
              </div>
            </NavLink>
          ))}
        </Lane>

        <Lane title="In flight" count={flightCount} accent="#fbbf24" bootDelay="0.22s">
          {flightCount === 0 && <p className="text-xs text-gray-500 px-1 py-1">Nothing here.</p>}
          {board.runs.running.map((r) => (
            <NavLink
              key={r.id}
              to={`/run?runId=${encodeURIComponent(r.id)}`}
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <Play className="w-4 h-4 flex-shrink-0 text-accent/70 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-100 truncate">{r.promptPreview || "(run)"}</div>
                <RowMeta>
                  {r.status} · started {timeAgo(r.startedAt)}
                </RowMeta>
              </div>
            </NavLink>
          ))}
          {board.agents.workingCount > 0 && (
            <NavLink
              to="/kanban"
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <Bot className="w-4 h-4 flex-shrink-0 text-accent/70 mt-0.5" />
              <div className="text-sm text-gray-100">
                {board.agents.workingCount} agent{board.agents.workingCount === 1 ? "" : "s"}{" "}
                working
              </div>
            </NavLink>
          )}
        </Lane>

        <Lane title="Done today" count={doneCount} accent="#34d399" bootDelay="0.34s">
          {doneCount === 0 && <p className="text-xs text-gray-500 px-1 py-1">Nothing here.</p>}
          {doneTodos.map((todo) => (
            <div
              key={`done:${todo.noteId}:${todo.line}`}
              className="flex items-start gap-2 px-2 py-1.5"
            >
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-400 line-through">{todo.text}</div>
                <RowMeta>{todo.noteTitle}</RowMeta>
              </div>
            </div>
          ))}
          {doneMonday.map((item) => (
            <div key={`done-monday:${item.id}`} className="flex items-start gap-2 px-2 py-1.5">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-400 line-through">{item.name}</div>
                <RowMeta>{item.boardName}</RowMeta>
              </div>
            </div>
          ))}
          {board.schedules.firedToday.map((s) => (
            <NavLink
              key={`fired:${s.id}`}
              to="/scheduled"
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <CalendarClock className="w-4 h-4 flex-shrink-0 text-emerald-400/70 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-300 truncate">{s.label || s.prompt}</div>
                <RowMeta>fired{s.firedAt ? ` ${timeAgo(s.firedAt)}` : ""}</RowMeta>
              </div>
            </NavLink>
          ))}
          {board.runs.completedToday.map((r) => (
            <NavLink
              key={`run:${r.id}`}
              to={`/run?runId=${encodeURIComponent(r.id)}`}
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400/70 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-300 truncate">{r.promptPreview || "(run)"}</div>
                <RowMeta>completed{r.endedAt ? ` ${timeAgo(r.endedAt)}` : ""}</RowMeta>
              </div>
            </NavLink>
          ))}
          {board.runs.failedToday.map((r) => (
            <NavLink
              key={`fail:${r.id}`}
              to={`/run?runId=${encodeURIComponent(r.id)}`}
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/60 rounded-lg"
            >
              <XCircle className="w-4 h-4 flex-shrink-0 text-red-400/70 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-300 truncate">{r.promptPreview || "(run)"}</div>
                <RowMeta>
                  {r.status}
                  {r.endedAt ? ` ${timeAgo(r.endedAt)}` : ""}
                </RowMeta>
              </div>
            </NavLink>
          ))}
        </Lane>
      </div>
    </div>
  );
}
