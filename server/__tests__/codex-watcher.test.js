/**
 * @file codex-watcher.test.js
 * @description Phase AB1 - passive Codex monitoring. Fixture rollouts in both
 * schema generations (2025-08 flat lines; 2026 wrapped {timestamp,type,payload})
 * are parsed and ingested into the sessions surface with provider 'codex',
 * then surfaced through the provider filter, facets, and the usage endpoint.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watcher-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.CODEX_HOME = path.join(TMP, ".codex");

const OLD_UUID = "bdffec99-24e1-43ef-b2f0-33f02051ec97";
const NEW_UUID = "46538edf-0aee-4827-8c58-9f69ad2b99a1";

function writeFixtures() {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "10");
  fs.mkdirSync(day, { recursive: true });

  // Old flat format (verified against a real 2025-08 rollout).
  const oldLines = [
    {
      id: OLD_UUID,
      timestamp: "2026-07-10T09:15:11.747Z",
      instructions: null,
      git: { branch: "main", repository_url: "https://github.com/x/y" },
    },
    { record_type: "state" },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/Users/me/proj-a</cwd>\n</environment_context>",
        },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "# Context from my IDE setup:\n\n## My request for Codex:\nfix the error in main.dart\n",
        },
      ],
    },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ];
  fs.writeFileSync(
    path.join(day, `rollout-2026-07-10T09-15-11-${OLD_UUID}.jsonl`),
    oldLines.map(JSON.stringify).join("\n") + "\n"
  );

  // New wrapped format ({timestamp, type, payload}).
  const newLines = [
    {
      timestamp: "2026-07-10T18-00-00",
      type: "session_meta",
      payload: {
        id: NEW_UUID,
        timestamp: "2026-07-10T18:00:00.000Z",
        cwd: "/Users/me/proj-b",
        cli_version: "0.99.0",
        git: { branch: "dev" },
      },
    },
    {
      timestamp: "t",
      type: "turn_context",
      payload: { cwd: "/Users/me/proj-b", model: "gpt-5.6-codex" },
    },
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "refactor the parser module" }],
      },
    },
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    },
    {
      timestamp: "t",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 300,
            total_tokens: 1500,
          },
        },
      },
    },
    { timestamp: "t", type: "unknown_future_event", payload: { anything: true } },
  ];
  fs.writeFileSync(
    path.join(day, `rollout-2026-07-10T18-00-00-${NEW_UUID}.jsonl`),
    newLines.map(JSON.stringify).join("\n") + "\n"
  );

  // Make both files stale so they ingest as completed (deterministic).
  const old = new Date(Date.now() - 60 * 60_000);
  for (const f of fs.readdirSync(day)) fs.utimesSync(path.join(day, f), old, old);
}

writeFixtures();

const { createApp, startServer } = require("../index");
const dbModule = require("../db");
const codex = require("../lib/codex-watcher");

let server;
let BASE;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(BASE + urlPath, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b || "{}") }));
      })
      .on("error", reject);
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  codex.stopCodexWatcher();
  if (server) server.close();
  if (dbModule.db) dbModule.db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("rollout parsing", () => {
  it("parses the old flat schema: id, cwd from env-context XML, IDE-wrapped ask", () => {
    const file = path.join(
      process.env.CODEX_HOME,
      "sessions",
      "2026",
      "07",
      "10",
      `rollout-2026-07-10T09-15-11-${OLD_UUID}.jsonl`
    );
    const p = codex.parseRolloutFile(file);
    assert.equal(p.id, OLD_UUID);
    assert.equal(p.cwd, "/Users/me/proj-a");
    assert.equal(p.name, "fix the error in main.dart");
    assert.equal(p.tokens, null, "old rollouts carry no token counts");
    assert.equal(p.git.branch, "main");
  });

  it("parses the wrapped schema: meta, model, tokens; unknown events skipped", () => {
    const file = path.join(
      process.env.CODEX_HOME,
      "sessions",
      "2026",
      "07",
      "10",
      `rollout-2026-07-10T18-00-00-${NEW_UUID}.jsonl`
    );
    const p = codex.parseRolloutFile(file);
    assert.equal(p.id, NEW_UUID);
    assert.equal(p.cwd, "/Users/me/proj-b");
    assert.equal(p.model, "gpt-5.6-codex");
    assert.equal(p.name, "refactor the parser module");
    assert.deepEqual(p.tokens, { input: 1200, cachedInput: 800, output: 300, total: 1500 });
  });

  it("survives a garbage file without throwing", () => {
    const bad = path.join(TMP, "bad.jsonl");
    fs.writeFileSync(bad, "not json\n{\n");
    assert.equal(codex.parseRolloutFile(bad), null);
  });
});

describe("ingestion into the sessions surface", () => {
  it("sweep upserts codex sessions as completed, provider-tagged rows", () => {
    const result = codex.sweepCodexSessions(dbModule, null);
    assert.equal(result.created, 2);

    const row = dbModule.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(codex.SESSION_ID_PREFIX + NEW_UUID);
    assert.ok(row, "row exists under the codex- prefixed id");
    assert.equal(row.provider, "codex");
    assert.equal(row.status, "completed", "stale file → completed");
    assert.equal(row.model, "gpt-5.6-codex");
    assert.equal(row.name, "refactor the parser module");
    const meta = JSON.parse(row.metadata);
    assert.equal(meta.readOnly, false, "AB2 exposes resume/steer through app-server");
    assert.equal(meta.threadId, NEW_UUID);
  });

  it("re-sweep is idempotent (unchanged files skipped)", () => {
    const again = codex.sweepCodexSessions(dbModule, null);
    assert.equal(again.created, 0);
    assert.equal(again.updated, 0);
  });

  it("existing claude rows/queries are untouched (default provider)", () => {
    dbModule.stmts.insertSession.run("claude-sess", "Claude one", "active", "/x", null, null);
    const row = dbModule.db
      .prepare("SELECT provider FROM sessions WHERE id = ?")
      .get("claude-sess");
    assert.equal(row.provider, "claude");
  });
});

describe("REST surface", () => {
  it("GET /api/sessions?provider=codex filters; facets list providers", async () => {
    const codexOnly = await get("/api/sessions?provider=codex");
    assert.equal(codexOnly.body.total, 2);
    assert.ok(codexOnly.body.sessions.every((s) => s.provider === "codex"));

    const claudeOnly = await get("/api/sessions?provider=claude");
    assert.ok(claudeOnly.body.sessions.every((s) => (s.provider || "claude") === "claude"));

    const facets = await get("/api/sessions/facets");
    assert.deepEqual(facets.body.providers.sort(), ["claude", "codex"]);
  });

  it("GET /api/analytics/codex reports totals with an honest unknown limit window", async () => {
    const { status, body } = await get("/api/analytics/codex");
    assert.equal(status, 200);
    assert.equal(body.configured, true);
    assert.equal(body.sessions, 2);
    assert.equal(body.tokens.total, 1500, "only the wrapped fixture carries counts");
    assert.equal(body.limitWindow, "unknown");
    assert.equal(body.byDay.length, 1);
    assert.equal(body.byDay[0].total, 1500);
  });
});
