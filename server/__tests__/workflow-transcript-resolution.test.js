/**
 * @file Tests for dual-layout (flat + nested Workflow-tool) sub-agent transcript
 * resolution. Covers the resolver helpers in server/lib/claude-home.js, the
 * durable snapshot writer in scripts/import-history.js, and the end-to-end
 * GET /:id/transcript?run_id= route that surfaces a workflow inner agent's full
 * (un-truncated) prompt/result text in the Workflows UI. Uses Node's built-in
 * test runner with temp CLAUDE_HOME / DASHBOARD_DATA_DIR roots.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

// Isolate the dashboard DB and Claude Code home BEFORE requiring server modules.
const STAMP = `wf-transcript-${Date.now()}-${process.pid}`;
const TMP = path.join(os.tmpdir(), STAMP);
const CLAUDE_HOME = path.join(TMP, "home");
const DATA_DIR = path.join(TMP, "data");
const TEST_DB = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.DASHBOARD_DATA_DIR = DATA_DIR;

const {
  resolveAgentTranscriptInDir,
  getSubagentTranscriptPath,
  findSubagentTranscriptPath,
  getSnapshotSubagentTranscriptPath,
} = require("../lib/claude-home");
const {
  snapshotTranscript,
  findSessionWorkflowSubagents,
} = require("../../scripts/import-history");
const { createApp, startServer } = require("../index");
const { db } = require("../db");

// encodeCwd is not exported; mirror its rule for building project paths.
const enc = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const CWD = "/tmp/cam-wf-project";
const SESSION = "sess-wf-resolve";
const SESSION_SNAP = "sess-wf-snapshot";
const RUN1 = "wf_run1aaaaaa";
const RUN2 = "wf_run2bbbbbb";
const WF_ID = "ad18a79192af10ed1"; // workflow inner agent - nested only
const FLAT_ID = "bd29b80203bf21fe2"; // regular sub-agent - flat
const DUP_ID = "cc1122334455667788"; // present in BOTH runs - ambiguous

const PROJECTS = path.join(CLAUDE_HOME, "projects");
const ENC_DIR = path.join(PROJECTS, enc(CWD));
const SUBAGENTS = path.join(ENC_DIR, SESSION, "subagents");

// A result longer than the journal's truncated preview would ever carry, so the
// route test can prove the full text (not a "…"-suffixed teaser) comes back.
const LONG_RESULT =
  "CONFIRMED: " +
  "the orbital telemetry reconciles across all three independent ground stations. ".repeat(8);
const PROMPT_TEXT = "Adversarially verify the starship claim against primary sources.";

function writeFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

function jsonl(lines) {
  return lines.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

function transcriptJsonl(prompt, result) {
  return jsonl([
    { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: result }] },
    },
  ]);
}

function fetch(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b || "{}") }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

let server;
let BASE;

before(async () => {
  // Live project tree: one flat sub-agent + nested workflow agents, with DUP_ID
  // deliberately present in two runs to exercise glob ambiguity.
  writeFile(path.join(SUBAGENTS, `agent-${FLAT_ID}.jsonl`), transcriptJsonl("flat", "flat-result"));
  writeFile(
    path.join(SUBAGENTS, "workflows", RUN1, `agent-${WF_ID}.jsonl`),
    transcriptJsonl(PROMPT_TEXT, LONG_RESULT)
  );
  writeFile(
    path.join(SUBAGENTS, "workflows", RUN1, `agent-${DUP_ID}.jsonl`),
    transcriptJsonl("dup-r1", "dup-r1-result")
  );
  writeFile(
    path.join(SUBAGENTS, "workflows", RUN2, `agent-${DUP_ID}.jsonl`),
    transcriptJsonl("dup-r2", "dup-r2-result")
  );

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
    /* ignore cleanup errors */
  }
});

describe("resolveAgentTranscriptInDir", () => {
  it("prefers the flat layout (regular sub-agents resolve unchanged)", () => {
    const hit = resolveAgentTranscriptInDir(SUBAGENTS, FLAT_ID);
    assert.equal(hit, path.join(SUBAGENTS, `agent-${FLAT_ID}.jsonl`));
  });

  it("resolves a nested Workflow agent directly when the runId is known", () => {
    const hit = resolveAgentTranscriptInDir(SUBAGENTS, WF_ID, RUN1);
    assert.equal(hit, path.join(SUBAGENTS, "workflows", RUN1, `agent-${WF_ID}.jsonl`));
  });

  it("resolves a nested agent by scanning when it appears in exactly one run", () => {
    const hit = resolveAgentTranscriptInDir(SUBAGENTS, WF_ID);
    assert.equal(hit, path.join(SUBAGENTS, "workflows", RUN1, `agent-${WF_ID}.jsonl`));
  });

  it("returns null for an agentId ambiguous across runs (no guessing)", () => {
    assert.equal(resolveAgentTranscriptInDir(SUBAGENTS, DUP_ID), null);
  });

  it("disambiguates an across-run agentId once the runId is supplied", () => {
    assert.equal(
      resolveAgentTranscriptInDir(SUBAGENTS, DUP_ID, RUN2),
      path.join(SUBAGENTS, "workflows", RUN2, `agent-${DUP_ID}.jsonl`)
    );
  });

  it("never throws and returns null for missing inputs", () => {
    assert.equal(resolveAgentTranscriptInDir(null, WF_ID), null);
    assert.equal(resolveAgentTranscriptInDir(SUBAGENTS, "does-not-exist"), null);
    assert.equal(resolveAgentTranscriptInDir(SUBAGENTS, WF_ID, "wf_nope"), null);
  });
});

describe("getSubagentTranscriptPath / findSubagentTranscriptPath", () => {
  it("resolves a nested Workflow agent via cwd + runId", () => {
    const hit = getSubagentTranscriptPath(SESSION, CWD, WF_ID, RUN1);
    assert.equal(hit, path.join(SUBAGENTS, "workflows", RUN1, `agent-${WF_ID}.jsonl`));
  });

  it("still resolves a flat regular sub-agent (no runId - no regression)", () => {
    const hit = getSubagentTranscriptPath(SESSION, CWD, FLAT_ID);
    assert.equal(hit, path.join(SUBAGENTS, `agent-${FLAT_ID}.jsonl`));
  });

  it("falls back to a project scan (cwd unknown) for the nested layout", () => {
    const hit = findSubagentTranscriptPath(SESSION, WF_ID, RUN1);
    assert.equal(hit, path.join(SUBAGENTS, "workflows", RUN1, `agent-${WF_ID}.jsonl`));
  });

  it("returns null when nothing resolves", () => {
    assert.equal(getSubagentTranscriptPath(SESSION, CWD, "missing", RUN1), null);
    assert.equal(getSubagentTranscriptPath(SESSION, null, WF_ID, RUN1), null);
  });
});

describe("snapshotTranscript (durable nested-layout fallback)", () => {
  it("discovers nested Workflow sub-agents separately from flat ones", () => {
    const mainPath = path.join(ENC_DIR, `${SESSION}.jsonl`);
    writeFile(mainPath, jsonl([{ type: "summary", summary: "x" }]));
    const found = findSessionWorkflowSubagents(mainPath);
    const rels = found.map((f) => f.rel).sort();
    assert.deepEqual(rels, [
      path.join("workflows", RUN1, `agent-${WF_ID}.jsonl`),
      path.join("workflows", RUN1, `agent-${DUP_ID}.jsonl`),
      path.join("workflows", RUN2, `agent-${DUP_ID}.jsonl`),
    ]);
  });

  it("preserves the nested layout into the snapshot so the read route resolves it", () => {
    // Build an independent source session, snapshot it, then resolve from the
    // snapshot dir exactly as the route's third fallback does.
    const srcMain = path.join(ENC_DIR, `${SESSION_SNAP}.jsonl`);
    const srcNested = path.join(
      ENC_DIR,
      SESSION_SNAP,
      "subagents",
      "workflows",
      RUN1,
      `agent-${WF_ID}.jsonl`
    );
    writeFile(srcMain, jsonl([{ type: "summary", summary: "snap" }]));
    writeFile(srcNested, transcriptJsonl(PROMPT_TEXT, LONG_RESULT));

    snapshotTranscript(srcMain, SESSION_SNAP);

    const snapHit = getSnapshotSubagentTranscriptPath(SESSION_SNAP, WF_ID, RUN1);
    assert.ok(snapHit, "snapshot resolver should find the preserved nested transcript");
    assert.equal(fs.readFileSync(snapHit, "utf8"), fs.readFileSync(srcNested, "utf8"));
  });

  it("does not throw for a session with no transcripts", () => {
    assert.doesNotThrow(() => snapshotTranscript(path.join(ENC_DIR, "nope.jsonl"), "nope"));
  });
});

describe("GET /:id/transcript?run_id= (full workflow agent text)", () => {
  it("returns the full, un-truncated prompt + result for a nested agent", async () => {
    const created = await post("/api/sessions", { id: SESSION, name: "wf", cwd: CWD });
    assert.equal(created.status, 201);

    const res = await fetch(
      `/api/sessions/${SESSION}/transcript?agent_id=${WF_ID}&run_id=${RUN1}&limit=200`
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));

    const texts = res.body.messages
      .flatMap((m) => m.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text);
    assert.ok(texts.includes(PROMPT_TEXT), "user prompt should be present in full");
    assert.ok(texts.includes(LONG_RESULT), "assistant result should be present in full");
    // The whole point of the fix: full text, not a "…"-suffixed teaser.
    assert.ok(!texts.some((t) => t.endsWith("…")));
  });

  it("returns an empty message list (no throw) for an unknown run/agent", async () => {
    const res = await fetch(
      `/api/sessions/${SESSION}/transcript?agent_id=${WF_ID}&run_id=wf_missing&limit=200`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, []);
  });
});
