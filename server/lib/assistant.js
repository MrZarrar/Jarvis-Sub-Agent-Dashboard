/**
 * @file assistant.js
 * @description Core logic for the voice/assistant endpoint (Phase D, §3.3 of
 * PLAN-jarvis-master.md). `handleAsk()` runs a small DETERMINISTIC keyword
 * prelude for the high-value voice intents BEFORE ever touching the brain:
 *
 *   • status               → live runs / waiting agents / active sessions
 *   • kill <run|all>       → stop a dashboard-spawned run
 *   • steer <run> <msg>    → send a follow-up message into a live conversation run
 *   • note: <dump>         → capture a brain dump (drained by Phase G's Notes)
 *   • run skill <name>     → Phase H (honest "not available yet" stub)
 *   • anything else        → the mini-Jarvis brain stub (server/lib/brain)
 *
 * The route (server/routes/assistant.js) is a thin HTTP shell over this; this is
 * where the behavior — and the tests — live. Every reply carries a `speech`
 * variant (short, no markdown, rounded numbers) that Siri reads aloud.
 *
 * @author Jarvis (Phase D)
 */

const { randomUUID } = require("node:crypto");
const runs = require("./run-spawner");
const brain = require("./brain");
const { toSpeech } = require("./brain/speech");

function db() {
  return require("../db").db;
}

/** Build a standard reply, deriving `speech` from `text` unless one is given. */
function reply(text, extra = {}) {
  return {
    text,
    speech: extra.speech != null ? extra.speech : toSpeech(text),
    intent: extra.intent || "chat",
    ...(extra.data ? { data: extra.data } : {}),
    ...(extra.provider ? { provider: extra.provider } : {}),
    ...(extra.taskClass ? { taskClass: extra.taskClass } : {}),
  };
}

// ── Intent matchers ─────────────────────────────────────────────────────────

/** `note: <text>` / `note - <text>` / `note <text>` → the captured text, else null. */
function matchNote(text) {
  const m = /^\s*note\s*[:\-]?\s+([\s\S]+)$/i.exec(text);
  return m ? m[1].trim() : null;
}

/** `run skill <name>` → the skill name, else null. */
function matchRunSkill(text) {
  const m = /^\s*run\s+skill\s+(.+)$/i.exec(text);
  return m ? m[1].trim() : null;
}

function isStatus(text) {
  return /^\s*(status|sitrep|report|what('|’)?s (going on|happening|up)|how are things|any updates?)\b/i.test(
    text
  );
}

function isKill(text) {
  return /^\s*(kill|stop|cancel|abort|terminate)\b/i.test(text);
}

/** Steer is intentionally narrow (explicit verbs) so "tell me the status" is NOT hijacked. */
function isSteer(text) {
  return /^\s*(steer|message)\b/i.test(text);
}

// ── Run helpers ───────────────────────────────────────────────────────────

function liveRuns() {
  return runs.listRuns().filter((r) => r.status === "running" || r.status === "spawning");
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "";
}

function runLabel(r) {
  const dir = r.cwd ? r.cwd.split("/").filter(Boolean).pop() : "";
  return dir ? `${shortId(r.id)} (${dir})` : shortId(r.id);
}

/**
 * Resolve which live run a command targets. Matches a full id or an 8-char
 * prefix mentioned anywhere in the text; otherwise falls back to the sole live
 * run when there is exactly one. Returns { run } | { ambiguous } | { none }.
 */
function resolveTargetRun(text, pool = liveRuns()) {
  if (pool.length === 0) return { none: true };
  const lower = text.toLowerCase();
  const byId = pool.find((r) => {
    const id = String(r.id).toLowerCase();
    return lower.includes(id) || lower.includes(id.slice(0, 8));
  });
  if (byId) return { run: byId };
  if (pool.length === 1) return { run: pool[0] };
  return { ambiguous: pool };
}

// ── Intent handlers ─────────────────────────────────────────────────────────

function handleStatus() {
  const live = liveRuns();
  const waitingRuns = live.filter((r) => (r.pendingPermissions || []).length > 0);

  let activeSessions = 0;
  let waitingAgents = 0;
  let workingAgents = 0;
  try {
    activeSessions = db()
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'")
      .get().c;
    waitingAgents = db()
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'waiting'")
      .get().c;
    workingAgents = db()
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'working'")
      .get().c;
  } catch {
    /* DB not ready (e.g. tests) — fall back to run-handle data only */
  }

  const lines = [];
  lines.push(
    `${live.length} dashboard run${live.length === 1 ? "" : "s"} live` +
      (waitingRuns.length ? `, ${waitingRuns.length} waiting on a permission decision` : "") +
      "."
  );
  lines.push(
    `${activeSessions} active session${activeSessions === 1 ? "" : "s"}, ` +
      `${workingAgents} agent${workingAgents === 1 ? "" : "s"} working, ` +
      `${waitingAgents} waiting on you.`
  );
  if (live.length) {
    lines.push("Runs: " + live.map(runLabel).join(", ") + ".");
  }

  const speechParts = [
    `${live.length} run${live.length === 1 ? "" : "s"} live`,
    `${activeSessions} active session${activeSessions === 1 ? "" : "s"}`,
  ];
  if (waitingRuns.length) speechParts.push(`${waitingRuns.length} waiting on a decision`);
  else if (waitingAgents) speechParts.push(`${waitingAgents} waiting on you`);
  const speech = speechParts.join(", ") + ".";

  return reply(lines.join(" "), {
    intent: "status",
    speech,
    data: {
      liveRuns: live.length,
      waitingRuns: waitingRuns.length,
      activeSessions,
      workingAgents,
      waitingAgents,
    },
  });
}

function handleKill(text) {
  const pool = liveRuns();
  if (pool.length === 0) {
    return reply("There are no live dashboard runs to stop.", { intent: "kill" });
  }
  // Explicit "kill all / everything" — the only path that stops more than one.
  if (/\b(all|everything|every run)\b/i.test(text)) {
    let killed = 0;
    for (const r of pool) {
      if (runs.killRun(r.id)) killed++;
    }
    return reply(`Stopped ${killed} run${killed === 1 ? "" : "s"}.`, {
      intent: "kill",
      data: { killed },
    });
  }
  const target = resolveTargetRun(text, pool);
  if (target.ambiguous) {
    return reply(
      `There are ${pool.length} live runs — say "kill all" or name one: ${pool
        .map(runLabel)
        .join(", ")}.`,
      { intent: "kill", data: { ambiguous: pool.map((r) => r.id) } }
    );
  }
  if (target.run) {
    const ok = runs.killRun(target.run.id);
    return reply(
      ok ? `Stopped run ${runLabel(target.run)}.` : `Couldn't stop run ${shortId(target.run.id)}.`,
      { intent: "kill", data: { killed: ok ? 1 : 0, id: target.run.id } }
    );
  }
  return reply("There are no live dashboard runs to stop.", { intent: "kill" });
}

function handleSteer(text) {
  // Strip the leading verb; the remainder (minus any run reference) is the message.
  const body = text.replace(/^\s*(steer|message)\b/i, "").trim();
  const convRuns = liveRuns().filter((r) => r.mode === "conversation");
  if (convRuns.length === 0) {
    return reply("There are no live conversation runs to steer.", { intent: "steer" });
  }
  const target = resolveTargetRun(text, convRuns);
  if (target.ambiguous) {
    return reply(
      `There are ${convRuns.length} live conversation runs — name one to steer: ${convRuns
        .map(runLabel)
        .join(", ")}.`,
      { intent: "steer", data: { ambiguous: convRuns.map((r) => r.id) } }
    );
  }
  const run = target.run;
  // Remove an 8-char id prefix / full id token from the message we forward.
  const message = body
    .replace(new RegExp(String(run.id), "ig"), "")
    .replace(new RegExp(shortId(run.id), "ig"), "")
    .trim();
  if (!message) {
    return reply("What should I tell the run?", { intent: "steer" });
  }
  try {
    runs.sendInput(run.id, message);
    return reply(`Sent to run ${runLabel(run)}.`, {
      intent: "steer",
      data: { id: run.id },
    });
  } catch (err) {
    return reply(`Couldn't steer that run: ${err.message}.`, { intent: "steer" });
  }
}

function captureNote(noteText, source) {
  const id = randomUUID();
  try {
    db()
      .prepare("INSERT INTO assistant_captures (id, text, source) VALUES (?, ?, ?)")
      .run(id, noteText, source || null);
  } catch (err) {
    return reply(`I couldn't save that note: ${err.message}.`, { intent: "note" });
  }
  return reply(
    "Noted. It's saved to your inbox and will be filed once the Notes system is set up.",
    { intent: "note", data: { id } }
  );
}

function runSkillStub(name) {
  return reply(
    `Skills aren't set up yet — that's a later phase. I noted you wanted to run "${name}".`,
    { intent: "run_skill", data: { skill: name } }
  );
}

/**
 * Route a user utterance. Deterministic intents win before the brain; anything
 * unmatched falls through to the (stubbed) mini-Jarvis brain.
 *
 * @returns {Promise<{text,speech,intent,...}>}
 */
async function handleAsk({ text, source = "chat", conversationId = null } = {}) {
  const trimmed = String(text == null ? "" : text).trim();
  if (!trimmed) {
    return reply("I didn't catch that. What would you like?", { intent: "empty" });
  }

  const note = matchNote(trimmed);
  if (note !== null) return captureNote(note, source);

  const skill = matchRunSkill(trimmed);
  if (skill !== null) return runSkillStub(skill);

  if (isKill(trimmed)) return handleKill(trimmed);
  if (isSteer(trimmed)) return handleSteer(trimmed);
  if (isStatus(trimmed)) return handleStatus();

  const out = await brain.ask({ text: trimmed, source, conversationId });
  return {
    text: out.text,
    speech: out.speech,
    intent: "chat",
    provider: out.provider,
    taskClass: out.taskClass,
    conversationId: out.conversationId,
  };
}

module.exports = {
  handleAsk,
  // exported for tests
  matchNote,
  matchRunSkill,
  isStatus,
  isKill,
  isSteer,
  resolveTargetRun,
};
