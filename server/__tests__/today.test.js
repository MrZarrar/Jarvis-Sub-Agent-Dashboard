/**
 * @file today.test.js
 * @description Tests for the Today board (Phase AC): the server-side aggregator
 * (note todos with line refs, Monday due lanes from the AD cache, today's
 * scheduled prompts, waiting agents, today's runs), the `- [ ]` → `- [x]`
 * line-rewrite through the notes write path (fixture vault - the file on disk
 * must change), and the route surface. Node's built-in test runner with a temp
 * DB + temp notes dir, mirroring notes.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "today-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
process.env.MONDAY_CONFIG_PATH = path.join(TMP, "monday.json");
delete process.env.MONDAY_TOKEN;

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const notes = require("../lib/notes");
const today = require("../lib/today");
const mondayClient = require("../lib/monday/client");
const mondayService = require("../lib/monday/service");

let server;
let BASE;
let note;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  note = notes.createNote({
    title: "Chores",
    body: "Intro line\n- [ ] buy milk\n- [x] already done\nSome prose\n- [ ] call mum",
  });
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("today aggregator", () => {
  it("lists open note todos with note id + body line refs (checked ones excluded)", () => {
    const board = today.getToday();
    const mine = board.todos.filter((t) => t.noteId === note.id);
    // Text + order are the contract; the line ref is whatever the body parse
    // yields (it's consumed by checkTodo, verified in the rewrite tests below).
    assert.deepEqual(
      mine.map((t) => t.text),
      ["buy milk", "call mum"]
    );
    assert.ok(mine.every((t) => Number.isInteger(t.line) && t.line >= 0));
    assert.ok(mine[0].line < mine[1].line);
    assert.equal(mine[0].noteTitle, "Chores");
  });

  it("surfaces Monday due/overdue lanes from the AD cache", () => {
    const overview = mondayClient.emptyOverview({
      configured: true,
      dueToday: [{ id: "1", boardId: "9", name: "Due thing", dueDate: "2026-07-10" }],
      overdue: [{ id: "2", boardId: "9", name: "Late thing", dueDate: "2026-07-01" }],
      counts: { mine: 0, dueToday: 1, overdue: 1, boards: 1 },
    });
    stmts.upsertMondayCache.run({
      data: JSON.stringify(overview),
      fingerprint: mondayService.fingerprint(overview),
      fetched_at: new Date().toISOString(),
      error: null,
    });
    const board = today.getToday();
    assert.equal(board.monday.configured, true);
    assert.equal(board.monday.dueToday[0].name, "Due thing");
    assert.equal(board.monday.overdue[0].name, "Late thing");
  });

  it("includes today's pending and fired scheduled prompts", () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO scheduled_prompts (id, prompt, trigger_kind, fire_at, status) VALUES (?, ?, 'at', ?, 'pending')"
    ).run("sched-1", "evening review", soon);
    db.prepare(
      "INSERT INTO scheduled_prompts (id, prompt, trigger_kind, fire_at, status, fired_at) VALUES (?, ?, 'at', ?, 'fired', ?)"
    ).run("sched-2", "morning kick", now.toISOString(), now.toISOString());

    const board = today.getToday();
    assert.deepEqual(
      board.schedules.pending.map((s) => s.id),
      ["sched-1"]
    );
    assert.deepEqual(
      board.schedules.firedToday.map((s) => s.id),
      ["sched-2"]
    );
  });

  it("lists waiting agents on active sessions and today's runs", () => {
    db.prepare("INSERT INTO sessions (id, status) VALUES ('sess-t', 'active')").run();
    db.prepare(
      "INSERT INTO agents (id, session_id, name, status, task) VALUES ('ag-t', 'sess-t', 'main', 'waiting', 'needs a yes')"
    ).run();
    db.prepare(
      "INSERT INTO dashboard_runs (id, mode, cwd, status, prompt_preview) VALUES ('run-a', 'headless', '/tmp', 'running', 'long job')"
    ).run();
    db.prepare(
      "INSERT INTO dashboard_runs (id, mode, cwd, status, prompt_preview) VALUES ('run-b', 'headless', '/tmp', 'completed', 'short job')"
    ).run();

    const board = today.getToday();
    assert.equal(board.agents.waiting[0].id, "ag-t");
    assert.equal(board.agents.waiting[0].task, "needs a yes");
    assert.deepEqual(
      board.runs.running.map((r) => r.id),
      ["run-a"]
    );
    assert.deepEqual(
      board.runs.completedToday.map((r) => r.id),
      ["run-b"]
    );
  });

  it("composes the briefing top line from the same aggregation", () => {
    const line = today.topLine();
    assert.match(line, /^On today's board: /);
    assert.match(line, /note todos/);
    assert.match(line, /Monday items due or overdue/);
    assert.match(line, /scheduled prompt/);
    assert.match(line, /agent waiting/);
  });
});

describe("today checkTodo line-rewrite", () => {
  it("rewrites the exact `- [ ]` line in the markdown file on disk", () => {
    const ref = today.getToday().todos.find((t) => t.noteId === note.id && t.text === "buy milk");
    const result = today.checkTodo({ noteId: note.id, line: ref.line, text: ref.text });
    assert.equal(result.line, ref.line);
    const raw = fs.readFileSync(note.path, "utf8");
    assert.match(raw, /- \[x\] buy milk/);
    assert.match(raw, /- \[ \] call mum/); // untouched
    // The board no longer lists it.
    const mine = today.getToday().todos.filter((t) => t.noteId === note.id);
    assert.deepEqual(
      mine.map((t) => t.text),
      ["call mum"]
    );
  });

  it("re-finds a todo by text when the line ref is stale", () => {
    const result = today.checkTodo({ noteId: note.id, line: 0, text: "call mum" });
    assert.match(fs.readFileSync(note.path, "utf8"), /- \[x\] call mum/);
    // It rewrote a real `- [x]` line, not line 0 blindly.
    const raw = fs.readFileSync(note.path, "utf8");
    const bodyLines = raw.split(/\r?\n/);
    assert.match(
      bodyLines.find((l) => l.includes("call mum")),
      /- \[x\]/
    );
    assert.ok(result.line >= 0);
  });

  it("can uncheck (checked:false) and throws for a missing todo", () => {
    today.checkTodo({ noteId: note.id, line: 0, text: "call mum", checked: false });
    assert.match(fs.readFileSync(note.path, "utf8"), /- \[ \] call mum/);
    assert.throws(
      () => today.checkTodo({ noteId: note.id, line: 0, text: "no such todo" }),
      /not found/
    );
  });
});

describe("today routes", () => {
  it("GET /api/today returns the aggregated board", async () => {
    const res = await req("GET", "/api/today");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.todos));
    assert.ok(res.body.monday);
    assert.ok(res.body.schedules);
    assert.ok(res.body.runs);
  });

  it("POST /api/today/todos/check rewrites through the route", async () => {
    const res = await req("POST", "/api/today/todos/check", {
      noteId: note.id,
      line: 4,
      text: "call mum",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(fs.readFileSync(note.path, "utf8"), /- \[x\] call mum/);
  });

  it("validates input and 404s an unknown note", async () => {
    const bad = await req("POST", "/api/today/todos/check", { noteId: "", text: "" });
    assert.equal(bad.status, 400);
    const gone = await req("POST", "/api/today/todos/check", {
      noteId: "nope",
      line: 0,
      text: "x",
    });
    assert.equal(gone.status, 404);
  });
});

describe("today todo add/edit/delete", () => {
  it("POST /api/today/todos appends to today's daily note (created on first add)", async () => {
    const res = await req("POST", "/api/today/todos", { text: "water the plants" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const d = new Date();
    const title = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(res.body.noteTitle, title);
    const daily = notes.getNote(res.body.noteId);
    assert.match(daily.body, /- \[ \] water the plants/);

    // Second add appends to the same note instead of creating another.
    const res2 = await req("POST", "/api/today/todos", { text: "stretch" });
    assert.equal(res2.body.noteId, res.body.noteId);
    assert.match(notes.getNote(res.body.noteId).body, /- \[ \] stretch/);
  });

  it("PUT /api/today/todos rewrites the text in place (box + indent preserved)", async () => {
    const ref = today.getToday().todos.find((t) => t.text === "water the plants");
    const res = await req("PUT", "/api/today/todos", {
      noteId: ref.noteId,
      line: ref.line,
      text: ref.text,
      newText: "water the garden",
    });
    assert.equal(res.status, 200);
    const body = notes.getNote(ref.noteId).body;
    assert.match(body, /- \[ \] water the garden/);
    assert.doesNotMatch(body, /water the plants/);
  });

  it("DELETE /api/today/todos removes the line and 404s a missing todo", async () => {
    const ref = today.getToday().todos.find((t) => t.text === "water the garden");
    const res = await req("DELETE", "/api/today/todos", {
      noteId: ref.noteId,
      line: ref.line,
      text: ref.text,
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(notes.getNote(ref.noteId).body, /water the garden/);

    const gone = await req("DELETE", "/api/today/todos", {
      noteId: ref.noteId,
      line: 0,
      text: "water the garden",
    });
    assert.equal(gone.status, 404);
    const bad = await req("POST", "/api/today/todos", { text: "   " });
    assert.equal(bad.status, 400);
  });
});

describe("business mode", () => {
  it("partitions business-tagged todos and blanks Monday", async () => {
    const biz = notes.createNote({
      title: "Business queue",
      body: "- [ ] inspect anonymous stock lot",
      tags: ["business"],
    });

    assert.ok(!today.getToday().todos.some((todo) => todo.noteId === biz.id));

    const res = await req("GET", "/api/today?mode=business");
    assert.equal(res.status, 200);
    assert.ok(res.body.todos.some((todo) => todo.noteId === biz.id));
    assert.equal(res.body.monday.configured, false);
    assert.deepEqual(res.body.monday.dueToday, []);
    assert.deepEqual(res.body.monday.overdue, []);
  });

  it("adds business todos to a separate tagged daily note", async () => {
    const res = await req("POST", "/api/today/todos", {
      text: "photograph anonymous item",
      mode: "business",
    });
    assert.equal(res.status, 200);
    assert.match(res.body.noteTitle, /^\d{4}-\d{2}-\d{2} Business$/);
    const created = notes.getNote(res.body.noteId);
    assert.ok(created.tags.includes("business"));
    assert.ok(
      today.getToday({ mode: "business" }).todos.some((todo) => todo.noteId === created.id)
    );
    assert.ok(!today.getToday().todos.some((todo) => todo.noteId === created.id));
  });
});
