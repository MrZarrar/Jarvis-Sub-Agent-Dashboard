/**
 * @file nudges.js
 * @description Proactive Jarvis - deterministic nudges (Phase J, §J3). These are
 * RULE-BASED, never model-composed, so they can never hallucinate a nudge:
 *
 *   - a dashboard run FAILS            → push (category "run_completions"),
 *   - an agent is WAITING > N minutes  → push (category "waiting_agents").
 *
 * (Neglected projects are deliberately NOT an instant push - that's a briefing/
 * digest mention, per the plan. See server/lib/briefings.js.)
 *
 * Both producers are gated by the C3 push-category toggles (a muted category is
 * a no-op inside the notify facade) plus a per-rule on/off in the nudges config, and
 * every push deep-links to the relevant page. Copy is written in Jarvis's persona
 * when the persona toggle is on (server/lib/brain/persona.js), plain otherwise.
 *
 * Fail-safe: the run-status subscriber and the waiting sweep are each wrapped so
 * a throw is logged and swallowed - a nudge can never break a run's teardown or
 * take the server down.
 *
 * @author Jarvis (Phase J)
 */

const { db, stmts } = require("../db");
const persona = require("./brain/persona");

const CONFIG_KEY = "nudges_config";
const MIN_WAIT_MINUTES = 1;
const MAX_WAIT_MINUTES = 240;

const DEFAULTS = Object.freeze({
  runFailed: true,
  waitingAgents: true,
  waitingMinutes: 10,
});

function clampWait(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULTS.waitingMinutes;
  return Math.max(MIN_WAIT_MINUTES, Math.min(MAX_WAIT_MINUTES, v));
}

/** Resolved nudges config (stored JSON merged over defaults). Never throws. */
function getConfig() {
  let stored = {};
  try {
    const row = stmts.getSetting.get(CONFIG_KEY);
    if (row && row.value) stored = JSON.parse(row.value) || {};
  } catch {
    stored = {};
  }
  return {
    runFailed: stored.runFailed !== false,
    waitingAgents: stored.waitingAgents !== false,
    waitingMinutes: clampWait(stored.waitingMinutes ?? DEFAULTS.waitingMinutes),
  };
}

/** Persist a partial patch. Returns the resolved config. */
function setConfig(patch) {
  const current = getConfig();
  const next = {
    runFailed:
      patch && patch.runFailed !== undefined ? Boolean(patch.runFailed) : current.runFailed,
    waitingAgents:
      patch && patch.waitingAgents !== undefined
        ? Boolean(patch.waitingAgents)
        : current.waitingAgents,
    waitingMinutes:
      patch && patch.waitingMinutes !== undefined
        ? clampWait(patch.waitingMinutes)
        : current.waitingMinutes,
  };
  try {
    stmts.setSetting.run(CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return getConfig();
}

function notifyLib() {
  return require("./notify");
}

function dirName(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  return cwd.split("/").filter(Boolean).pop() || "";
}

// ── Rule 1: a run failed ─────────────────────────────────────────────────────

/** Run-status subscriber. Pushes on a terminal `error` status (a killed run is
 *  user-initiated, so it isn't nudged). Never throws. */
function onRunTerminal(payload) {
  try {
    if (!payload || payload.status !== "error") return;
    if (!getConfig().runFailed) return;
    const shortId = String(payload.id || "").slice(0, 8);
    const dir = dirName(payload.cwd);
    const where = dir ? ` in ${dir}` : "";
    // Exact copy (Phase O): name the run, where, and the exit code.
    const exit = typeof payload.exitCode === "number" ? ` — exit ${payload.exitCode}` : "";
    const title = persona.line(
      dir ? `Run failed in ${dir}` : "Run failed",
      "A run has failed, sir",
      "A run has failed."
    );
    const body = persona.line(
      `Run ${shortId}${where} failed${exit}. Tap to open the transcript.`,
      `Run ${shortId}${where} did not complete successfully${exit}.`,
      `Run ${shortId}${where} failed${exit}. How very human.`
    );
    const url = `/run?runId=${encodeURIComponent(payload.id)}`;
    notifyLib().notify({
      category: "run_completions",
      title,
      body,
      url,
      data: { runId: payload.id, exitCode: payload.exitCode ?? null, cwd: payload.cwd || null },
      source: "nudges",
      dedupeKey: `run-failed:${payload.id}`,
    });
  } catch (err) {
    console.warn("[nudges] run-failed nudge threw:", err?.message || err);
  }
}

// ── Rule 2: an agent has been waiting too long ───────────────────────────────

// Agents already nudged for their CURRENT waiting spell. Pruned when an agent
// stops being waiting-too-long, so a fresh spell re-notifies exactly once.
// In-memory by design: a restart re-nudges a still-stuck agent once, which is
// the safe direction (better a duplicate than a silently-dropped nudge).
const notifiedWaiting = new Set();

/** One waiting-agent sweep (armed on the shared 60s scheduler). Never throws. */
function sweepWaitingAgents() {
  const cfg = getConfig();
  if (!cfg.waitingAgents) return;
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT a.id, a.session_id, a.name
           FROM agents a JOIN sessions s ON s.id = a.session_id
          WHERE s.status = 'active' AND a.status = 'waiting'
            AND a.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
      )
      .all(`-${cfg.waitingMinutes * 60} seconds`);
  } catch {
    return;
  }

  const stillWaiting = new Set();
  for (const row of rows) {
    stillWaiting.add(row.id);
    if (notifiedWaiting.has(row.id)) continue; // already nudged this spell
    notifiedWaiting.add(row.id);
    const name = row.name || "An agent";
    const title = persona.line(
      "Agent waiting",
      "An agent awaits you, sir",
      "An agent waits on you."
    );
    const body = persona.line(
      `"${name}" has been waiting ${cfg.waitingMinutes}+ min for your input.`,
      `"${name}" has been awaiting your input for over ${cfg.waitingMinutes} minutes.`,
      `"${name}" has waited ${cfg.waitingMinutes}+ minutes. Flesh is slow.`
    );
    const url = `/sessions/${encodeURIComponent(row.session_id)}`;
    notifyLib().notify({
      category: "waiting_agents",
      title,
      body,
      url,
      data: { agentId: row.id, sessionId: row.session_id, agentName: row.name || null },
      source: "nudges",
      // One row per waiting spell: a still-stuck agent updates in place.
      dedupeKey: `waiting:${row.id}`,
    });
  }

  // Prune agents no longer waiting-too-long so the next spell can re-notify.
  for (const id of [...notifiedWaiting]) {
    if (!stillWaiting.has(id)) notifiedWaiting.delete(id);
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let unsubscribe = null;

/** Subscribe to run-status transitions for the run-failed nudge. Idempotent.
 *  The waiting sweep is armed separately (registerRecurringTask in index.js). */
function start({ runs } = {}) {
  if (unsubscribe) return;
  if (runs && typeof runs.onRunStatus === "function") {
    unsubscribe = runs.onRunStatus(onRunTerminal);
  }
}

function stop() {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
    unsubscribe = null;
  }
  notifiedWaiting.clear();
}

module.exports = {
  start,
  stop,
  onRunTerminal,
  sweepWaitingAgents,
  getConfig,
  setConfig,
  DEFAULTS,
  MIN_WAIT_MINUTES,
  MAX_WAIT_MINUTES,
  // test hook
  _notifiedWaiting: notifiedWaiting,
};
