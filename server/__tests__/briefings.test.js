/**
 * @file briefings.test.js
 * @description Tests for Proactive Jarvis (Phase J): the JARVIS persona layer,
 * the briefing composer (deterministic fallback - providers are disabled so no
 * model call happens), the briefings REST surface + config round-trip, the
 * deterministic nudges (waiting-agent sweep dedup + run-failed gating), and the
 * "morning briefing" voice-intent matcher. Node's built-in test runner with a
 * temp DB + temp notes dir, mirroring notes.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "briefings-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
// Disable every provider so briefing composition exercises its deterministic
// (no-model) fallback - tests never make a network/spawn call.
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({
    gemini: { enabled: false, apiKey: "" },
    ollama: { enabled: false },
    claude: { enabled: false },
    openai: { enabled: false },
  })
);

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const persona = require("../lib/brain/persona");
const briefings = require("../lib/briefings");
const nudges = require("../lib/nudges");
const assistant = require("../lib/assistant");

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

describe("persona layer", () => {
  it("is enabled by default and prepends the persona block to a system prompt", () => {
    persona.setEnabled(true);
    assert.equal(persona.isEnabled(), true);
    const composed = persona.applyToSystem("BASE INSTRUCTIONS");
    assert.match(composed, /JARVIS/);
    assert.match(composed, /BASE INSTRUCTIONS$/);
    assert.equal(persona.line("plain", "fancy, sir"), "fancy, sir");
  });

  it("reverts to neutral phrasing when disabled", () => {
    persona.setEnabled(false);
    assert.equal(persona.isEnabled(), false);
    assert.equal(persona.applyToSystem("BASE"), "BASE");
    assert.equal(persona.line("plain", "fancy, sir"), "plain");
    persona.setEnabled(true); // restore for later tests
  });
});

describe("persona variant (Phase N: Ultron)", () => {
  after(() => {
    persona.setHudMode("jarvis");
    persona.setEnabled(true);
  });

  it("selects the ultron variant off the stored HUD mode", () => {
    persona.setEnabled(true);
    persona.setHudMode("jarvis");
    assert.equal(persona.variant(), "jarvis");
    assert.match(persona.applyToSystem("BASE"), /JARVIS/);

    persona.setHudMode("ultron");
    assert.equal(persona.variant(), "ultron");
    assert.match(persona.applyToSystem("BASE"), /ULTRON/);

    // "auto" resolves to JARVIS server-side (the client reports "ultron"
    // explicitly when an auto-trigger flips it).
    persona.setHudMode("auto");
    assert.equal(persona.variant(), "jarvis");
  });

  it("line() returns ultron copy in ultron mode, falls back to jarvis otherwise", () => {
    persona.setEnabled(true);
    persona.setHudMode("ultron");
    assert.equal(persona.line("plain", "jarvis", "ultron"), "ultron");
    // No ultron variant supplied → falls back to the jarvis copy, never plain.
    assert.equal(persona.line("plain", "jarvis"), "jarvis");

    persona.setHudMode("jarvis");
    assert.equal(persona.line("plain", "jarvis", "ultron"), "jarvis");

    // Persona off outranks the variant entirely.
    persona.setEnabled(false);
    assert.equal(persona.line("plain", "jarvis", "ultron"), "plain");
    persona.setEnabled(true);
  });

  it("composes an in-character Ultron briefing and labels the row", async () => {
    persona.setEnabled(true);
    persona.setHudMode("ultron");
    const composed = await briefings.compose("morning");
    assert.equal(composed.personaVariant, "ultron");
    assert.doesNotMatch(composed.text, /sir/i); // Ultron never says "sir"

    const row = await briefings.runBriefing({ kind: "morning", trigger: "manual" });
    assert.equal(row.persona, "ultron", "briefing row labelled with the voice that spoke");
    persona.setHudMode("jarvis");
  });

  it("PUT /api/settings/hud-mode persists the mode and reports the variant", async () => {
    const put = await req("PUT", "/api/settings/hud-mode", { mode: "ultron" });
    assert.equal(put.status, 200);
    assert.equal(put.body.hud_mode, "ultron");
    assert.equal(put.body.variant, "ultron");
    assert.equal(persona.getHudMode(), "ultron");

    const bad = await req("PUT", "/api/settings/hud-mode", { mode: "skynet" });
    assert.equal(bad.status, 400);

    await req("PUT", "/api/settings/hud-mode", { mode: "jarvis" });
  });
});

describe("briefing composer (deterministic fallback)", () => {
  it("composes a morning briefing locally with the JARVIS voice", async () => {
    persona.setEnabled(true);
    const { text, provider } = await briefings.compose("morning");
    assert.equal(provider, null, "no provider configured → deterministic");
    assert.match(text, /sir/i);
    assert.ok(text.length > 0);
  });

  it("drops the persona voice when disabled", async () => {
    persona.setEnabled(false);
    const { text } = await briefings.compose("morning");
    assert.doesNotMatch(text, /sir/i);
    assert.match(text, /briefing/i);
    persona.setEnabled(true);
  });

  it("runBriefing persists a row, files a note, and yields speech", async () => {
    const row = await briefings.runBriefing({ kind: "evening", trigger: "manual" });
    assert.equal(row.kind, "evening");
    assert.ok(row.id);
    assert.ok(typeof row.speech === "string" && row.speech.length > 0);
    // Speech is single-line (no markdown, whitespace collapsed).
    assert.doesNotMatch(row.speech, /\n/);
    assert.ok(row.note_id, "briefing filed as a note");
    const list = briefings.listBriefings({ limit: 10 });
    assert.ok(list.some((b) => b.id === row.id));
  });
});

describe("briefings REST surface", () => {
  it("runs a briefing over HTTP and lists it", async () => {
    const run = await req("POST", "/api/briefings/run", { kind: "morning" });
    assert.equal(run.status, 201);
    assert.equal(run.body.briefing.kind, "morning");

    const list = await req("GET", "/api/briefings?limit=5");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.items));
    assert.ok(list.body.items.some((b) => b.id === run.body.briefing.id));
    assert.ok(list.body.latest.morning, "latest morning present");
  });

  it("round-trips the combined Phase-J config", async () => {
    const put = await req("PUT", "/api/briefings/config", {
      persona: false,
      morning: { enabled: true, time: "06:30" },
      nudges: { waitingMinutes: 25, runFailed: false },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.persona, false);
    assert.equal(put.body.config.morning.time, "06:30");
    assert.equal(put.body.config.nudges.waitingMinutes, 25);
    assert.equal(put.body.config.nudges.runFailed, false);

    const get = await req("GET", "/api/briefings/config");
    assert.equal(get.body.config.persona, false);
    assert.equal(get.body.config.morning.time, "06:30");

    // A composed briefing now uses neutral phrasing (persona persisted off).
    const run = await req("POST", "/api/briefings/run", { kind: "morning" });
    assert.doesNotMatch(run.body.briefing.text, /sir/i);

    // Restore the persona for any later assertions.
    await req("PUT", "/api/briefings/config", {
      persona: true,
      nudges: { waitingMinutes: 10, runFailed: true },
    });
  });

  it("clamps an out-of-range waiting threshold", () => {
    assert.equal(
      nudges.setConfig({ waitingMinutes: 9999 }).waitingMinutes,
      nudges.MAX_WAIT_MINUTES
    );
    assert.equal(nudges.setConfig({ waitingMinutes: 0 }).waitingMinutes, nudges.MIN_WAIT_MINUTES);
    nudges.setConfig({ waitingMinutes: 10 });
  });
});

describe("deterministic nudges", () => {
  it("nudges a long-waiting agent exactly once per spell, then re-arms", () => {
    nudges.setConfig({ waitingAgents: true, waitingMinutes: 10 });
    nudges._notifiedWaiting.clear();

    const old = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
    db.prepare("INSERT INTO sessions (id, name, status) VALUES (?, ?, 'active')").run(
      "sess-nudge",
      "Nudge session"
    );
    db.prepare(
      "INSERT INTO agents (id, session_id, name, type, status, updated_at) VALUES (?, ?, ?, 'main', 'waiting', ?)"
    ).run("agent-nudge", "sess-nudge", "Stuck agent", old);

    nudges.sweepWaitingAgents();
    assert.ok(nudges._notifiedWaiting.has("agent-nudge"), "nudged once");

    // Second sweep: already nudged, set membership unchanged (no re-notify).
    nudges.sweepWaitingAgents();
    assert.equal(nudges._notifiedWaiting.size, 1);

    // Agent stops waiting → pruned so a future spell can re-notify.
    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run("agent-nudge");
    nudges.sweepWaitingAgents();
    assert.ok(!nudges._notifiedWaiting.has("agent-nudge"), "pruned when no longer waiting");
  });

  it("respects the waitingAgents disable flag", () => {
    nudges.setConfig({ waitingAgents: false });
    nudges._notifiedWaiting.clear();
    db.prepare("UPDATE agents SET status = 'waiting' WHERE id = ?").run("agent-nudge");
    nudges.sweepWaitingAgents();
    assert.equal(nudges._notifiedWaiting.size, 0, "no nudge when disabled");
    nudges.setConfig({ waitingAgents: true });
  });

  it("run-failed nudge only fires on error status and never throws", () => {
    // No push subscribers in the test → sendPushToAll is a no-op; we assert the
    // guard logic runs cleanly for each status.
    nudges.setConfig({ runFailed: true });
    assert.doesNotThrow(() => nudges.onRunTerminal({ id: "r1", status: "completed" }));
    assert.doesNotThrow(() => nudges.onRunTerminal({ id: "r2", status: "killed" }));
    assert.doesNotThrow(() =>
      nudges.onRunTerminal({ id: "r3", status: "error", cwd: "/tmp/proj" })
    );
    nudges.setConfig({ runFailed: false });
    assert.doesNotThrow(() => nudges.onRunTerminal({ id: "r4", status: "error" }));
    nudges.setConfig({ runFailed: true });
  });
});

describe("briefing voice intent", () => {
  it("matches morning / evening briefing utterances", () => {
    assert.equal(assistant.matchBriefing("morning briefing"), "morning");
    assert.equal(assistant.matchBriefing("brief me"), "morning");
    assert.equal(assistant.matchBriefing("end of day summary"), "evening");
    assert.equal(assistant.matchBriefing("evening summary please"), "evening");
    assert.equal(assistant.matchBriefing("what's the status"), null);
    assert.equal(assistant.matchBriefing("kill run 12345678"), null);
  });
});
