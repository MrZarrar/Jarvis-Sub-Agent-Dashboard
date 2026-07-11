/**
 * @file demo.test.js
 * @description Demo mode routes: start seeds the fixture + crew sessions and
 * the "Demo tasks" note, status reports active, stop removes every demo row
 * and the note while leaving user data untouched. Temp DB + temp notes dir,
 * mirroring today.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "demo-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
process.env.MONDAY_CONFIG_PATH = path.join(TMP, "monday.json");
delete process.env.MONDAY_TOKEN;

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const notes = require("../lib/notes");

let server;
let BASE;

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

describe("demo mode", () => {
  it("starts inactive", async () => {
    const res = await req("GET", "/api/demo");
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);
  });

  it("start seeds demo sessions, one agent per Room cast, and the tasks note", async () => {
    // A user row that must survive the demo lifecycle untouched.
    stmts.insertSession.run("real-user-session", "My real work", "active", "/home/me", null, null);

    const res = await req("POST", "/api/demo/start");
    assert.equal(res.status, 200);
    assert.equal(res.body.active, true);
    assert.equal((await req("GET", "/api/demo")).body.active, true);

    const demoSessions = db
      .prepare("SELECT id FROM sessions WHERE id LIKE 'demo-%'")
      .all()
      .map((r) => r.id);
    assert.equal(demoSessions.length, 3); // solo + nested + crew

    // Crew covers every casting: tools + waiting/completed/error statuses.
    const crew = db
      .prepare("SELECT status, current_tool FROM agents WHERE session_id LIKE 'demo-crew-%'")
      .all();
    const tools = new Set(crew.map((a) => a.current_tool).filter(Boolean));
    for (const tool of ["Task", "WebSearch", "Write", "Bash", "Read", "TodoWrite"]) {
      assert.ok(tools.has(tool), `expected a crew agent using ${tool}`);
    }
    const statuses = new Set(crew.map((a) => a.status));
    for (const s of ["working", "waiting", "completed", "error"]) {
      assert.ok(statuses.has(s), `expected a crew agent with status ${s}`);
    }

    // The tasks note exists and feeds the Today board.
    const note = notes.listNotes({ limit: 500 }).find((n) => n.title === "Demo tasks");
    assert.ok(note, "Demo tasks note created");
    const board = await req("GET", "/api/today");
    assert.ok(board.body.todos.some((t) => t.noteTitle === "Demo tasks"));
  });

  it("start is idempotent (re-start resets, no duplicates)", async () => {
    await req("POST", "/api/demo/start");
    const count = db.prepare("SELECT COUNT(*) c FROM sessions WHERE id LIKE 'demo-%'").get().c;
    assert.equal(count, 3);
    const noteCount = notes.listNotes({ limit: 500 }).filter((n) => n.title === "Demo tasks");
    assert.equal(noteCount.length, 1);
  });

  it("stop removes all demo rows and the note, keeping user data", async () => {
    const res = await req("POST", "/api/demo/stop");
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);

    assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE id LIKE 'demo-%'").get().c, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM agents WHERE session_id LIKE 'demo-%'").get().c,
      0
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM events WHERE session_id LIKE 'demo-%'").get().c,
      0
    );
    assert.equal(notes.listNotes({ limit: 500 }).filter((n) => n.title === "Demo tasks").length, 0);
    // The real session is untouched.
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = 'real-user-session'").get());
    assert.equal((await req("GET", "/api/demo")).body.active, false);
  });
});
