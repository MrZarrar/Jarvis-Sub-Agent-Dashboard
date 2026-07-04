/**
 * @file Tests for human-readable session names and the transcript rename
 * marker. Covers:
 *   - TranscriptCache surfacing the latest custom-title / ai-title.
 *   - The hook ingestor syncing sessions.name from the transcript title, with
 *     custom-title winning and ai-title only filling placeholder names.
 *   - GET /:id/transcript surfacing custom-title (/rename) as a synthetic
 *     `session_event` marker, deduped, with ai-title excluded.
 * Uses Node's built-in test runner with temp CLAUDE_HOME / DASHBOARD_DATA_DIR.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const STAMP = `sess-name-${Date.now()}-${process.pid}`;
const TMP = path.join(os.tmpdir(), STAMP);
const CLAUDE_HOME = path.join(TMP, "home");
const DATA_DIR = path.join(TMP, "data");
const TEST_DB = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.DASHBOARD_DATA_DIR = DATA_DIR;

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const TranscriptCache = require("../lib/transcript-cache");

const enc = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const PROJECTS = path.join(CLAUDE_HOME, "projects");

function jsonl(lines) {
  return lines.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

function writeTranscript(cwd, sessionId, lines) {
  const p = path.join(PROJECTS, enc(cwd), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, jsonl(lines));
  return p;
}

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

let server;
let BASE;

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
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

describe("TranscriptCache - title extraction", () => {
  it("returns the latest custom-title and ai-title (last value wins)", () => {
    const cwd = "/tmp/cam-name-cache";
    const sid = "cache-titles";
    const p = writeTranscript(cwd, sid, [
      { type: "ai-title", aiTitle: "Auto one", sessionId: sid },
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "ai-title", aiTitle: "Auto two", sessionId: sid },
      { type: "custom-title", customTitle: "my-feature", sessionId: sid },
    ]);
    const r = new TranscriptCache().extract(p);
    assert.equal(r.customTitle, "my-feature");
    assert.equal(r.aiTitle, "Auto two");
  });

  it("returns a result for a transcript that has ONLY a title line", () => {
    const cwd = "/tmp/cam-name-only";
    const sid = "only-title";
    const p = writeTranscript(cwd, sid, [
      { type: "custom-title", customTitle: "title-only", sessionId: sid },
    ]);
    const r = new TranscriptCache().extract(p);
    assert.ok(r, "result should not be null");
    assert.equal(r.customTitle, "title-only");
  });
});

describe("hook ingestor - sessions.name sync from transcript", () => {
  it("sets the name to the custom-title on the next hook event", async () => {
    const cwd = "/tmp/cam-name-custom";
    const sid = "11111111-2222-3333-4444-555555555555";
    const tpath = writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "custom-title", customTitle: "auth-refactor", sessionId: sid },
    ]);
    const res = await req("POST", "/api/hooks/event", {
      hook_type: "Stop",
      data: { session_id: sid, cwd, transcript_path: tpath },
    });
    assert.equal(res.status, 200);
    const row = stmts.getSession.get(sid);
    assert.equal(row.name, "auth-refactor");
  });

  it("fills a placeholder name with the ai-title when there is no custom-title", async () => {
    const cwd = "/tmp/cam-name-ai";
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const tpath = writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "ai-title", aiTitle: "Investigate flaky test", sessionId: sid },
    ]);
    await req("POST", "/api/hooks/event", {
      hook_type: "Stop",
      data: { session_id: sid, cwd, transcript_path: tpath },
    });
    const row = stmts.getSession.get(sid);
    assert.equal(row.name, "Investigate flaky test");
  });

  it("does not let an ai-title clobber a user-chosen name, but a custom-title does", async () => {
    const cwd = "/tmp/cam-name-precedence";
    const sid = "99999999-8888-7777-6666-555555555555";
    // Seed a real, user-chosen name via the sessions API.
    await req("POST", "/api/sessions", { id: sid, name: "keep-me", cwd });

    // An ai-title must NOT overwrite the user-chosen name.
    let tpath = writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "x" } },
      { type: "ai-title", aiTitle: "Auto generated", sessionId: sid },
    ]);
    await req("POST", "/api/hooks/event", {
      hook_type: "Stop",
      data: { session_id: sid, cwd, transcript_path: tpath },
    });
    assert.equal(stmts.getSession.get(sid).name, "keep-me");

    // But an explicit /rename (custom-title) always wins.
    tpath = writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "x" } },
      { type: "ai-title", aiTitle: "Auto generated", sessionId: sid },
      { type: "custom-title", customTitle: "renamed-explicitly", sessionId: sid },
    ]);
    await req("POST", "/api/hooks/event", {
      hook_type: "Stop",
      data: { session_id: sid, cwd, transcript_path: tpath },
    });
    assert.equal(stmts.getSession.get(sid).name, "renamed-explicitly");
  });
});

describe("GET /:id/transcript - rename markers", () => {
  it("surfaces custom-title as a deduped session_event and excludes ai-title", async () => {
    const cwd = "/tmp/cam-rename-marker";
    const sid = "deadbeef-0000-1111-2222-333333333333";
    writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "ai-title", aiTitle: "noise 1", sessionId: sid },
      { type: "custom-title", customTitle: "feature-x", sessionId: sid },
      { type: "ai-title", aiTitle: "noise 2", sessionId: sid },
      // Duplicate custom-title with the SAME value - must be deduped away.
      { type: "custom-title", customTitle: "feature-x", sessionId: sid },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      { type: "custom-title", customTitle: "feature-y", sessionId: sid },
    ]);
    // Register the session so the endpoint doesn't 404.
    await req("POST", "/api/sessions", { id: sid, cwd });

    const res = await req("GET", `/api/sessions/${sid}/transcript?limit=200`);
    assert.equal(res.status, 200);
    const events = res.body.messages.filter((m) => m.type === "session_event");
    const titles = events.map((e) => e.title);
    // feature-x once (dupe collapsed), then feature-y. No ai-title leaks in.
    assert.deepEqual(titles, ["feature-x", "feature-y"]);
    assert.ok(
      events.every((e) => e.event_kind === "rename"),
      "every marker is a rename"
    );
    assert.ok(
      !res.body.messages.some((m) => m.type === "session_event" && /noise/.test(m.title || "")),
      "ai-title values are never surfaced in the transcript stream"
    );
  });
});

describe("GET /:id/transcript - local slash-command output (system/local_command)", () => {
  it("surfaces /color command + its stdout, skips empty + noise system lines", async () => {
    const cwd = "/tmp/cam-local-cmd";
    const sid = "c010rrrr-1111-2222-3333-444444444444";
    writeTranscript(cwd, sid, [
      { type: "user", message: { role: "user", content: "hi" } },
      // /color, current Claude Code shape: command + output as system/local_command
      {
        type: "system",
        subtype: "local_command",
        content:
          "<command-name>/color</command-name>\n            <command-message>color</command-message>\n            <command-args></command-args>",
        sessionId: sid,
      },
      { type: "agent-color", agentColor: "cyan", sessionId: sid },
      {
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>Session color set to: cyan</local-command-stdout>",
        sessionId: sid,
      },
      // /clear writes a content-less local_command line - must NOT become a row
      { type: "system", subtype: "local_command", content: "", sessionId: sid },
      // unrelated system subtype - pure noise, must be dropped
      { type: "system", subtype: "turn_duration", durationMs: 1200, sessionId: sid },
    ]);
    await req("POST", "/api/sessions", { id: sid, cwd });

    const res = await req("GET", `/api/sessions/${sid}/transcript?limit=200`);
    assert.equal(res.status, 200);
    const texts = res.body.messages.flatMap((m) =>
      m.content.filter((c) => c.type === "text").map((c) => c.text)
    );
    assert.ok(
      texts.some((tx) => tx.includes("<command-name>/color</command-name>")),
      "the /color command invocation is surfaced"
    );
    assert.ok(
      texts.some((tx) => tx.includes("Session color set to: cyan")),
      "the /color stdout is surfaced"
    );
    // Empty local_command (/clear) and turn_duration noise produce no message.
    assert.ok(
      !texts.some((tx) => /turn_duration|durationMs/.test(tx)),
      "non-local_command system subtypes are not surfaced"
    );
    // Exactly two surfaced rows from the system lines (command + stdout), plus
    // the one real user message - the empty + noise lines add nothing.
    assert.equal(res.body.messages.length, 3);
  });
});
