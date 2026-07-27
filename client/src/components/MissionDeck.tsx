/**
 * @file MissionDeck.tsx
 * @description Holographic mission deck for the main dashboard: today's open
 * note todos (checkable, quick-add) beside Monday items due/overdue
 * (checkable), so neither lives only in its own page. Self-contained like the
 * GitHub/Finance widgets: fetches GET /api/today itself, reloads on the same
 * WS events the Today board listens to, and the Monday half self-hides when
 * no token is configured. Deep-links to /today and /monday for the full
 * boards; checking here uses the same write paths as the Today page.
 */

import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { ListTodo, ClipboardList, ArrowRight, Plus } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { useWorkMode } from "../lib/workMode";
import { Checkbox } from "./Checkbox";
import type { MondayItem, TodayBoard, TodayTodo, WSMessage } from "../lib/types";

const RELOAD_EVENTS = new Set(["note_changed", "monday_updated"]);
const MAX_ROWS = 6;

export function MissionDeck() {
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);
  // Business mode (Phase BM): business todo lane; the server blanks Monday.
  const workMode = useWorkMode();

  const load = useCallback(async () => {
    try {
      setBoard(await api.today.board(workMode));
    } catch {
      /* board unreachable - deck self-hides */
    }
  }, [workMode]);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (RELOAD_EVENTS.has(msg.type)) load();
    });
  }, [load]);

  if (!board) return null;

  const mondayDue = board.monday.configured
    ? [...board.monday.overdue, ...board.monday.dueToday]
    : [];
  const showMonday = board.monday.configured;

  const addTodo = async () => {
    const text = newText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.today.addTodo({ text, mode: workMode });
      setNewText("");
      await load();
    } catch {
      /* the Today page surfaces write errors; here we just stay quiet */
    } finally {
      setBusy(false);
    }
  };

  const checkTodo = async (todo: TodayTodo) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.today.checkTodo({ noteId: todo.noteId, line: todo.line, text: todo.text });
      setBoard((b) =>
        b
          ? {
              ...b,
              todos: b.todos.filter((t) => !(t.noteId === todo.noteId && t.line === todo.line)),
            }
          : b
      );
    } catch {
      /* ignore - next reload restores truth */
    } finally {
      setBusy(false);
    }
  };

  const checkMonday = async (item: MondayItem) => {
    if (busy || !item.statusColumnId) return;
    setBusy(true);
    try {
      await api.monday.markDone(item.id, item.boardId);
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
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`grid grid-cols-1 ${showMonday ? "lg:grid-cols-2" : ""} gap-4`}>
      {/* Today's missions */}
      <div
        className="holo-panel hud-frame holo-boot p-4 flex flex-col gap-2 min-w-0"
        style={{ "--boot-delay": "0.5s" } as React.CSSProperties}
      >
        <div className="flex items-center justify-between">
          <h3 className="hud-label text-xs flex items-center gap-2">
            <ListTodo className="w-3.5 h-3.5 text-accent" /> Today's missions
          </h3>
          <NavLink to="/today" className="btn-ghost text-xs">
            Board <ArrowRight className="w-3 h-3" />
          </NavLink>
        </div>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-2/40 border border-border/60 focus-within:border-accent/50 transition-colors">
          <Plus className="w-3.5 h-3.5 text-accent/70 flex-shrink-0" />
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTodo()}
            placeholder="Add a task…"
            className="flex-1 min-w-0 bg-transparent text-sm text-gray-100 placeholder-gray-600 outline-none"
          />
        </div>
        {board.todos.length === 0 ? (
          <p className="text-xs text-gray-600 px-1 py-1">All clear — nothing on the list.</p>
        ) : (
          board.todos.slice(0, MAX_ROWS).map((todo) => (
            <div
              key={`${todo.noteId}:${todo.line}`}
              className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-surface-3/60 transition-colors"
            >
              <Checkbox checked={false} onChange={() => checkTodo(todo)} />
              <span className="text-sm text-gray-200 truncate flex-1">{todo.text}</span>
              <span className="text-[10px] text-gray-600 truncate max-w-[8rem] flex-shrink-0">
                {todo.noteTitle}
              </span>
            </div>
          ))
        )}
        {board.todos.length > MAX_ROWS && (
          <NavLink to="/today" className="text-[11px] text-accent hover:text-accent/80 px-2">
            +{board.todos.length - MAX_ROWS} more…
          </NavLink>
        )}
      </div>

      {/* Monday due/overdue */}
      {showMonday && (
        <div
          className="holo-panel hud-frame holo-boot p-4 flex flex-col gap-2 min-w-0"
          style={{ "--boot-delay": "0.58s" } as React.CSSProperties}
        >
          <div className="flex items-center justify-between">
            <h3 className="hud-label text-xs flex items-center gap-2">
              <ClipboardList className="w-3.5 h-3.5 text-accent" /> Monday
            </h3>
            <NavLink to="/monday" className="btn-ghost text-xs">
              Boards <ArrowRight className="w-3 h-3" />
            </NavLink>
          </div>
          {mondayDue.length === 0 ? (
            <p className="text-xs text-gray-600 px-1 py-1">Nothing due or overdue today.</p>
          ) : (
            mondayDue.slice(0, MAX_ROWS).map((item) => {
              const overdue = board.monday.overdue.some((i) => i.id === item.id);
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-surface-3/60 transition-colors"
                >
                  <Checkbox checked={false} onChange={() => checkMonday(item)} />
                  <span className="text-sm text-gray-200 truncate flex-1">{item.name}</span>
                  <span
                    className={`text-[10px] flex-shrink-0 ${overdue ? "text-red-400" : "text-gray-600"}`}
                  >
                    {overdue ? "overdue" : item.dueDate ? `due ${item.dueDate}` : item.boardName}
                  </span>
                </div>
              );
            })
          )}
          {mondayDue.length > MAX_ROWS && (
            <NavLink to="/monday" className="text-[11px] text-accent hover:text-accent/80 px-2">
              +{mondayDue.length - MAX_ROWS} more…
            </NavLink>
          )}
        </div>
      )}
    </div>
  );
}
