/**
 * @file today.js
 * @description Today board aggregator (Phase AC). Server-side aggregation with
 * NO new storage - every lane reads state earlier phases already maintain:
 *   - open note todos: `- [ ]` lines parsed live from the notes index (G1/G2;
 *     the markdown files stay the source of truth - Obsidian sees every check),
 *   - Monday items due/overdue today (AD cache, no network),
 *   - today's scheduled prompts (L, scheduled_prompts table),
 *   - waiting/working agents and today's dashboard runs (existing tables).
 * One endpoint, one shape, computed fresh per request (everything read here is
 * already in-process SQLite or small files - no cache layer needed).
 *
 * Checking a note todo rewrites that `- [ ]` → `- [x]` line through the
 * existing notes write path (updateNote), so the file on disk changes and the
 * watcher/broadcast pipeline picks it up like any other edit. Checking a
 * Monday item goes through monday/client.markDone (routes/monday.js) - not
 * duplicated here.
 *
 * @author Jarvis (Phase AC)
 */

const { db } = require("../db");
const notes = require("./notes");

const MAX_TODOS = 200;
const MAX_ROWS = 20; // per runs/schedules/agents list

const TODO_RE = /^\s*-\s*\[( |x|X)\]\s*(.*)$/;

/** Local YYYY-MM-DD (the board is a wall-clock concept). */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayIso() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

const BUSINESS_TAG = "business";

function hasBusinessTag(meta) {
  return (
    Array.isArray(meta.tags) && meta.tags.some((tag) => String(tag).toLowerCase() === BUSINESS_TAG)
  );
}

/** All open `- [ ]` todos across notes, each with its note id + body line ref
 *  (the ref the check endpoint rewrites). Fail-safe: a bad note is skipped. */
function collectNoteTodos(mode) {
  const out = [];
  let list = [];
  try {
    list = notes.listNotes({ limit: 500 });
  } catch {
    return out;
  }
  list = list.filter((meta) =>
    mode === BUSINESS_TAG ? hasBusinessTag(meta) : !hasBusinessTag(meta)
  );
  for (const meta of list) {
    if (out.length >= MAX_TODOS) break;
    let full;
    try {
      full = notes.getNote(meta.id);
    } catch {
      continue;
    }
    if (!full || typeof full.body !== "string") continue;
    const lines = full.body.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < MAX_TODOS; i++) {
      const m = lines[i].match(TODO_RE);
      if (m && m[1] === " ") {
        out.push({ noteId: full.id, noteTitle: full.title, line: i, text: m[2].trim() });
      }
    }
  }
  return out;
}

/** Monday due/overdue lanes straight from the AD cache (no network). */
function collectMonday() {
  try {
    const { overview } = require("./monday/service").getCached();
    if (!overview || !overview.configured) return { configured: false, dueToday: [], overdue: [] };
    return {
      configured: true,
      dueToday: overview.dueToday || [],
      overdue: overview.overdue || [],
    };
  } catch {
    return { configured: false, dueToday: [], overdue: [] };
  }
}

/** Scheduled prompts (Phase L) relevant to today: pending 'at' ones that fire
 *  today, and ones that already fired today (the Done lane). Direct table reads
 *  so this works whether or not the scheduler singleton is armed. */
function collectSchedules() {
  const shape = (r) => ({
    id: r.id,
    label: r.label,
    prompt: r.prompt,
    fireAt: r.fire_at,
    firedAt: r.fired_at || null,
    status: r.status,
  });
  let pending = [];
  let firedToday = [];
  try {
    pending = db
      .prepare(
        "SELECT * FROM scheduled_prompts WHERE status = 'pending' AND trigger_kind = 'at' AND fire_at >= ? AND fire_at < ? ORDER BY fire_at ASC LIMIT ?"
      )
      .all(startOfTodayIso(), endOfTodayIso(), MAX_ROWS)
      .map(shape);
  } catch {
    pending = [];
  }
  try {
    firedToday = db
      .prepare(
        "SELECT * FROM scheduled_prompts WHERE status = 'fired' AND fired_at >= ? ORDER BY fired_at DESC LIMIT ?"
      )
      .all(startOfTodayIso(), MAX_ROWS)
      .map(shape);
  } catch {
    firedToday = [];
  }
  return { pending, firedToday };
}

/** Agents on active sessions: waiting ones as rows (they need the user),
 *  working ones as a count (they're just in flight). */
function collectAgents() {
  let waiting = [];
  let working = 0;
  try {
    waiting = db
      .prepare(
        "SELECT a.id, a.name, a.task, a.session_id FROM agents a JOIN sessions s ON s.id = a.session_id WHERE s.status = 'active' AND a.status = 'waiting' ORDER BY a.started_at DESC LIMIT ?"
      )
      .all(MAX_ROWS)
      .map((r) => ({ id: r.id, name: r.name, task: r.task, sessionId: r.session_id }));
  } catch {
    waiting = [];
  }
  try {
    working = db
      .prepare(
        "SELECT COUNT(*) AS c FROM agents a JOIN sessions s ON s.id = a.session_id WHERE s.status = 'active' AND a.status = 'working'"
      )
      .get().c;
  } catch {
    working = 0;
  }
  return { waiting, workingCount: working };
}

/** Today's dashboard runs: running (In flight) + completed/failed (Done). */
function collectRuns() {
  const shape = (r) => ({
    id: r.id,
    promptPreview: r.prompt_preview,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at || null,
  });
  const since = startOfTodayIso();
  let rows = [];
  try {
    rows = db
      .prepare("SELECT * FROM dashboard_runs WHERE started_at >= ? ORDER BY started_at DESC")
      .all(since);
  } catch {
    rows = [];
  }
  const running = rows
    .filter((r) => r.status === "running" || r.status === "spawning")
    .slice(0, MAX_ROWS)
    .map(shape);
  const completed = rows
    .filter((r) => r.status === "completed")
    .slice(0, MAX_ROWS)
    .map(shape);
  const failed = rows
    .filter((r) => r.status === "error" || r.status === "killed")
    .slice(0, MAX_ROWS)
    .map(shape);
  return { running, completedToday: completed, failedToday: failed };
}

/** The whole board in one shape. Never throws. Business mode partitions only
 * the todo lane; shared schedules, agents, and runs remain visible. */
function getToday({ mode } = {}) {
  const business = mode === BUSINESS_TAG;
  return {
    date: localToday(),
    todos: collectNoteTodos(mode),
    monday: business ? { configured: false, dueToday: [], overdue: [] } : collectMonday(),
    schedules: collectSchedules(),
    agents: collectAgents(),
    runs: collectRuns(),
  };
}

/**
 * Check (or uncheck) one note todo: rewrite its `- [ ]`/`- [x]` line in the
 * markdown file via the existing notes write path. The line index is verified
 * against the text before rewriting; if the note changed since the board
 * loaded, the todo is found again by exact text (first match) instead. Throws
 * with a message when the todo can't be located - the route surfaces it.
 */
function checkTodo({ noteId, line, text, checked = true }) {
  const { note, lines, idx } = locateTodo({ noteId, line, text });
  lines[idx] = lines[idx].replace(/-\s*\[( |x|X)\]/, checked ? "- [x]" : "- [ ]");
  notes.updateNote(note.id, { body: lines.join("\n") });
  return { noteId, line: idx, checked: Boolean(checked) };
}

/** Shared locator for the todo write paths: verify the line index against the
 *  text; if the note changed since the board loaded, re-find by exact text. */
function locateTodo({ noteId, line, text }) {
  const note = notes.getNote(noteId);
  if (!note) throw new Error("note not found");
  const lines = note.body.split(/\r?\n/);
  const wanted = String(text || "").trim();

  const matchesAt = (i) => {
    const m = typeof lines[i] === "string" && lines[i].match(TODO_RE);
    return m && m[2].trim() === wanted ? m : null;
  };

  let idx = Number.isInteger(line) && matchesAt(line) ? line : -1;
  if (idx === -1) idx = lines.findIndex((_l, i) => matchesAt(i));
  if (idx === -1) throw new Error("todo not found - the note changed since the board loaded");
  return { note, lines, idx };
}

/** Add a new open todo to the normal or business daily note. */
function addTodo({ text, mode }) {
  const clean = String(text || "")
    .trim()
    .replace(/\r?\n/g, " ");
  if (!clean) throw new Error("text is required");
  const business = mode === BUSINESS_TAG;
  const title = business ? `${localToday()} Business` : localToday();
  let note = null;
  try {
    const meta = notes.listNotes({ limit: 500 }).find((n) => n.title === title);
    if (meta) note = notes.getNote(meta.id);
  } catch {
    /* index unreadable - fall through to create */
  }
  const todoLine = `- [ ] ${clean}`;
  if (!note) {
    note = notes.createNote({
      title,
      body: todoLine,
      tags: business ? ["daily", BUSINESS_TAG] : ["daily"],
    });
    return { noteId: note.id, noteTitle: note.title, line: 0, text: clean };
  }
  const body = note.body.length && !note.body.endsWith("\n") ? `${note.body}\n` : note.body;
  const lines = body.split(/\r?\n/);
  notes.updateNote(note.id, { body: `${body}${todoLine}` });
  return { noteId: note.id, noteTitle: note.title, line: lines.length - 1, text: clean };
}

/** Rewrite one todo's text in place (checkbox state preserved). */
function editTodo({ noteId, line, text, newText }) {
  const clean = String(newText || "")
    .trim()
    .replace(/\r?\n/g, " ");
  if (!clean) throw new Error("newText is required");
  const { note, lines, idx } = locateTodo({ noteId, line, text });
  // Only the text after the checkbox changes - indentation and box state stay.
  lines[idx] = lines[idx].replace(/(\[(?: |x|X)\])\s*.*$/, (_m, box) => `${box} ${clean}`);
  notes.updateNote(note.id, { body: lines.join("\n") });
  return { noteId, line: idx, text: clean };
}

/** Remove one todo line from its note entirely. */
function deleteTodo({ noteId, line, text }) {
  const { note, lines, idx } = locateTodo({ noteId, line, text });
  lines.splice(idx, 1);
  notes.updateNote(note.id, { body: lines.join("\n") });
  return { noteId, line: idx, deleted: true };
}

/** One honest sentence for the morning briefing (Phase AC §4) - composed from
 *  the same aggregation, no second aggregator. Null when there's nothing. */
function topLine() {
  try {
    const t = getToday();
    const bits = [];
    if (t.todos.length) bits.push(`${t.todos.length} note todo${t.todos.length === 1 ? "" : "s"}`);
    const due = t.monday.dueToday.length + t.monday.overdue.length;
    if (due) bits.push(`${due} Monday item${due === 1 ? "" : "s"} due or overdue`);
    if (t.schedules.pending.length) {
      bits.push(
        `${t.schedules.pending.length} scheduled prompt${t.schedules.pending.length === 1 ? "" : "s"}`
      );
    }
    if (t.agents.waiting.length) {
      bits.push(
        `${t.agents.waiting.length} agent${t.agents.waiting.length === 1 ? "" : "s"} waiting`
      );
    }
    return bits.length ? `On today's board: ${bits.join(", ")}.` : null;
  } catch {
    return null;
  }
}

module.exports = { getToday, checkTodo, addTodo, editTodo, deleteTodo, topLine, collectNoteTodos };
