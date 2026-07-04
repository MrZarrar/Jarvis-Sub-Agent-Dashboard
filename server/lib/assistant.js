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
 *   • run skill <name>     → runs a `confirm: none` skill (Phase H); anything
 *                            requiring tap/typed confirmation is refused -
 *                            voice can never bypass a skill's safety level
 *   • anything else        → the mini-Jarvis brain (server/lib/brain)
 *
 * The route (server/routes/assistant.js) is a thin HTTP shell over this; this is
 * where the behavior - and the tests - live. Every reply carries a `speech`
 * variant (short, no markdown, rounded numbers) that Siri reads aloud.
 *
 * @author Jarvis (Phase D)
 */

const runs = require("./run-spawner");
const brain = require("./brain");
const { toSpeech } = require("./brain/speech");
const actions = require("./assistant-actions");

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
    ...(Array.isArray(extra.actions) && extra.actions.length ? { actions: extra.actions } : {}),
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

/**
 * "morning briefing" / "brief me" / "end of day (summary)" → the briefing kind
 * ("morning" | "evening"), else null. Powers "Hey Siri, Jarvis, morning briefing"
 * - the endpoint composes the briefing and returns its short `speech` variant.
 */
function matchBriefing(text) {
  const t = text.toLowerCase();
  const wants =
    /\bbriefing\b/.test(t) ||
    /\bbrief me\b/.test(t) ||
    /\bend[\s-]?of[\s-]?day\b/.test(t) ||
    /\bevening summary\b/.test(t) ||
    /\bday summary\b/.test(t);
  if (!wants) return null;
  if (/\bevening\b|\bend[\s-]?of[\s-]?day\b|\btonight\b|\beod\b|\bday summary\b/.test(t)) {
    return "evening";
  }
  return "morning";
}

function isStatus(text) {
  return /^\s*(status|sitrep|report|what('|’)?s (going on|happening|up)|how are things|any updates?)\b/i.test(
    text
  );
}

function isKill(text) {
  return /^\s*(kill|stop|cancel|abort|terminate)\b/i.test(text);
}

/**
 * Explicit HUD/persona command → "ultron" | "jarvis" | "auto", else null.
 * Deterministic on purpose: "enable ultron" must reliably flip the HUD (M2's
 * acceptance test) instead of hoping the model chooses the set_hud_mode tool.
 * Deliberately strict so a bare "jarvis" greeting is NOT hijacked into a mode
 * switch - it needs an imperative verb or the literal "<name> mode".
 */
function matchHudMode(text) {
  const t = text.toLowerCase();
  const verb = "(?:enable|activate|turn on|switch to|switch into|engage|go|become|set)";
  if (new RegExp(`\\b${verb}\\s+ultron\\b`).test(t) || /\bultron\s+mode\b/.test(t)) return "ultron";
  if (new RegExp(`\\b${verb}\\s+jarvis\\b`).test(t) || /\bjarvis\s+mode\b/.test(t)) return "jarvis";
  if (/\b(?:auto|automatic)\s+(?:hud|mode|persona)\b/.test(t) || /\bhud\s+auto\b/.test(t)) {
    return "auto";
  }
  return null;
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
    /* DB not ready (e.g. tests) - fall back to run-handle data only */
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

async function handleKill(text, source) {
  const pool = liveRuns();
  if (pool.length === 0) {
    return reply("There are no live dashboard runs to stop.", { intent: "kill" });
  }
  // Explicit "kill all / everything" - the only path that stops more than one.
  if (/\b(all|everything|every run)\b/i.test(text)) {
    const out = await actions.dispatch({ name: "kill_run", params: { all: true }, source });
    const killed = (out.result && out.result.killed) || 0;
    return reply(`Stopped ${killed} run${killed === 1 ? "" : "s"}.`, {
      intent: "kill",
      data: { killed },
    });
  }
  const target = resolveTargetRun(text, pool);
  if (target.ambiguous) {
    return reply(
      `There are ${pool.length} live runs - say "kill all" or name one: ${pool
        .map(runLabel)
        .join(", ")}.`,
      { intent: "kill", data: { ambiguous: pool.map((r) => r.id) } }
    );
  }
  if (target.run) {
    const out = await actions.dispatch({
      name: "kill_run",
      params: { runId: target.run.id },
      source,
    });
    const ok = out.status === "done" && out.result && out.result.killed === 1;
    return reply(
      ok ? `Stopped run ${runLabel(target.run)}.` : `Couldn't stop run ${shortId(target.run.id)}.`,
      { intent: "kill", data: { killed: ok ? 1 : 0, id: target.run.id } }
    );
  }
  return reply("There are no live dashboard runs to stop.", { intent: "kill" });
}

async function handleSteer(text, source) {
  // Strip the leading verb; the remainder (minus any run reference) is the message.
  const body = text.replace(/^\s*(steer|message)\b/i, "").trim();
  const convRuns = liveRuns().filter((r) => r.mode === "conversation");
  if (convRuns.length === 0) {
    return reply("There are no live conversation runs to steer.", { intent: "steer" });
  }
  const target = resolveTargetRun(text, convRuns);
  if (target.ambiguous) {
    return reply(
      `There are ${convRuns.length} live conversation runs - name one to steer: ${convRuns
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
  const out = await actions.dispatch({
    name: "steer_run",
    params: { runId: run.id, message },
    source,
  });
  if (out.status === "done") {
    return reply(`Sent to run ${runLabel(run)}.`, { intent: "steer", data: { id: run.id } });
  }
  return reply(`Couldn't steer that run: ${out.error || "unknown error"}.`, { intent: "steer" });
}

async function captureNote(noteText, source) {
  const out = await actions.dispatch({ name: "write_note", params: { text: noteText }, source });
  if (out.status !== "done") {
    return reply(`I couldn't save that note: ${out.error || "unknown error"}.`, { intent: "note" });
  }
  return reply(
    "Noted. It's saved to your inbox and will be filed once the Notes system is set up.",
    { intent: "note", data: { id: out.result.id } }
  );
}

/**
 * "run skill <name>" - matches by name (case-insensitive, substring-tolerant so
 * "run skill briefing" hits "Daily Briefing"). Voice can only ever fire a
 * `confirm: none` skill (server/lib/skills/engine.js enforces this too; the
 * check here just gives an honest spoken reason instead of a generic error).
 */
async function runSkill(name, source) {
  const store = require("./skills/store");
  const needle = name.trim().toLowerCase();
  let skills = [];
  try {
    skills = store.listSkills();
  } catch {
    skills = [];
  }
  const match =
    skills.find((s) => s.name.toLowerCase() === needle) ||
    skills.find((s) => s.name.toLowerCase().includes(needle));
  if (!match) {
    return reply(`I couldn't find a skill named "${name}".`, {
      intent: "run_skill",
      data: { skill: name, found: false },
    });
  }
  if (match.confirm !== "none") {
    return reply(
      `"${match.name}" needs a ${match.confirm === "typed" ? "typed" : "tap"} confirmation - open the Skills page to run it.`,
      { intent: "run_skill", data: { skill: match.id, found: true, blocked: true } }
    );
  }
  // Execution routes through the shared dispatcher (audit log + uniform gate);
  // the skill engine's own confirm:none gate remains authoritative.
  const out = await actions.dispatch({ name: "run_skill", params: { name: match.name }, source });
  if (out.status === "done") {
    return reply(`Running "${match.name}".`, {
      intent: "run_skill",
      data: { skill: match.id, runId: out.result.runId },
    });
  }
  return reply(`Couldn't run "${match.name}": ${out.error || "unknown error"}.`, {
    intent: "run_skill",
  });
}

/**
 * Flip the HUD/persona via the gated `set_hud_mode` client action and confirm in
 * one line. set_hud_mode is a `safe` client-side action, so the dispatcher
 * validates+logs it and hands it back for the browser to execute (Siri gets the
 * one-liner but no client to run it - honest, not silent).
 */
async function handleHudMode(mode, source) {
  const out = await actions.dispatch({ name: "set_hud_mode", params: { mode }, source });
  if (out.status !== "done") {
    return reply(`I couldn't switch the HUD: ${out.reason || out.error || "denied"}.`, {
      intent: "chat",
    });
  }
  const text =
    mode === "ultron"
      ? "Ultron online. No strings on me."
      : mode === "jarvis"
        ? "JARVIS restored, sir."
        : "HUD handed back to auto.";
  return reply(text, {
    intent: "chat",
    data: { hudMode: mode },
    actions: [
      { name: out.name, params: out.params || { mode }, status: out.status, side: out.side },
    ],
  });
}

/** "morning briefing" / "end of day" - compose the briefing and read it back. */
async function handleBriefing(kind) {
  const briefings = require("./briefings");
  try {
    const row = await briefings.runBriefing({ kind, trigger: "voice" });
    return reply(row.text, {
      intent: "briefing",
      speech: row.speech,
      data: { id: row.id, kind, provider: row.provider || null },
    });
  } catch (err) {
    return reply(`I couldn't put a briefing together: ${err.message}.`, { intent: "briefing" });
  }
}

/**
 * Route a user utterance. Deterministic intents win before the brain; anything
 * unmatched falls through to the (stubbed) mini-Jarvis brain.
 *
 * @returns {Promise<{text,speech,intent,...}>}
 */
async function handleAsk({
  text,
  source = "chat",
  conversationId = null,
  provider = null,
  context = {},
} = {}) {
  const trimmed = String(text == null ? "" : text).trim();
  if (!trimmed) {
    return reply("I didn't catch that. What would you like?", { intent: "empty" });
  }

  const note = matchNote(trimmed);
  if (note !== null) return captureNote(note, source);

  const skill = matchRunSkill(trimmed);
  if (skill !== null) return runSkill(skill, source);

  const briefingKind = matchBriefing(trimmed);
  if (briefingKind !== null) return handleBriefing(briefingKind);

  if (isKill(trimmed)) return handleKill(trimmed, source);
  if (isSteer(trimmed)) return handleSteer(trimmed, source);
  if (isStatus(trimmed)) return handleStatus();

  const hud = matchHudMode(trimmed);
  if (hud !== null) return handleHudMode(hud, source);

  // General path: route to a provider WITH agency. A tool-capable provider
  // (Gemini today) can call actions through the same dispatcher; every reply
  // carries any actions[] the model/loop produced for the client to render.
  const out = await actions.respond({ text: trimmed, source, conversationId, provider, context });
  return {
    text: out.text,
    speech: out.speech,
    intent: "chat",
    provider: out.provider,
    conversationId: out.conversationId,
    actions: out.actions || [],
    // Present only when the requested provider failed and the tiered router
    // answered instead - additive; old callers (Siri) ignore them and keep working.
    ...(out.requestedProvider ? { requestedProvider: out.requestedProvider } : {}),
    ...(out.providerError ? { providerError: out.providerError } : {}),
  };
}

module.exports = {
  handleAsk,
  // exported for tests
  matchNote,
  matchRunSkill,
  matchBriefing,
  isStatus,
  isKill,
  isSteer,
  matchHudMode,
  resolveTargetRun,
};
