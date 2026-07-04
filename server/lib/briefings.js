/**
 * @file briefings.js
 * @description Proactive Jarvis - briefings (Phase J, §J1–J2). Composes a
 * morning briefing and an end-of-day summary from state the earlier phases
 * already produce:
 *   - project pulse (Phase G2)  → what's active / neglected,
 *   - GitHub overview (Phase I) → PRs awaiting review, red CI,
 *   - dashboard runs            → what ran / completed / failed today,
 *   - agents                    → what's waiting on the user.
 *
 * Context assembly is DETERMINISTIC. The prose is then written by the brain
 * (standard tier, in Jarvis's persona) when a provider is configured; with no
 * provider it degrades to a deterministic, honestly-composed briefing built from
 * the same facts - so this never invents anything and always produces something
 * usable. Each briefing is persisted (briefings table), filed as a markdown note
 * (Phase G1), pushed (category "briefings"), and broadcast (`briefing_created`).
 *
 * Scheduling reuses the SHARED scheduler (Phase L) - a single 60s tick fires the
 * morning/evening briefing when the wall clock crosses its configured time, once
 * per day per kind (a persisted last-fired date guards against restart double-
 * fires and a late catch-up beyond a grace window is skipped). Fail-safe: every
 * DB touch and every fire is guarded; a briefing error never crashes the tick.
 *
 * @author Jarvis (Phase J)
 */

const { randomUUID } = require("node:crypto");
const { db, stmts } = require("../db");
const router = require("./brain/router");
const persona = require("./brain/persona");
const { toSpeech } = require("./brain/speech");

// Lazy requires (avoid load-order cycles; each is independently fail-safe).
const push = () => require("./push");
const pulse = () => require("./brain/pulse");
const notes = () => require("./notes");
const github = () => require("./github/service");
const broadcastFn = () => {
  try {
    return require("../websocket").broadcast;
  } catch {
    return null;
  }
};

// ── Config (app_settings KV; no schema, no secrets) ─────────────────────────

const CONFIG_KEY = "briefings_config";
const GRACE_MINUTES = 180; // catch up a missed briefing within 3h, else skip today

const DEFAULTS = Object.freeze({
  morning: { enabled: true, time: "07:00" },
  evening: { enabled: true, time: "18:00" },
});

function parseHHMM(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Resolved briefings config (stored JSON merged over defaults). Never throws. */
function getConfig() {
  let stored = {};
  try {
    const row = stmts.getSetting.get(CONFIG_KEY);
    if (row && row.value) stored = JSON.parse(row.value) || {};
  } catch {
    stored = {};
  }
  const m = stored.morning || {};
  const e = stored.evening || {};
  return {
    morning: {
      enabled: m.enabled !== false,
      time: parseHHMM(m.time, DEFAULTS.morning.time),
    },
    evening: {
      enabled: e.enabled !== false,
      time: parseHHMM(e.time, DEFAULTS.evening.time),
    },
  };
}

/** Persist a partial patch over the stored config. Returns the resolved config. */
function setConfig(patch) {
  const current = getConfig();
  const next = {
    morning: { ...current.morning, ...(patch && patch.morning) },
    evening: { ...current.evening, ...(patch && patch.evening) },
  };
  next.morning.time = parseHHMM(next.morning.time, DEFAULTS.morning.time);
  next.evening.time = parseHHMM(next.evening.time, DEFAULTS.evening.time);
  next.morning.enabled = next.morning.enabled !== false;
  next.evening.enabled = next.evening.enabled !== false;
  try {
    stmts.setSetting.run(CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return getConfig();
}

// ── Context assembly (deterministic) ────────────────────────────────────────

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Assemble the raw facts a briefing is built from. Every source is guarded so a
 *  missing table / unconfigured integration simply omits that section. */
function assembleContext() {
  const ctx = {
    projects: { neglected: [], active: [], idle: [], openTodos: 0 },
    github: null,
    runs: { completed: 0, failed: 0, running: 0, total: 0 },
    agents: { waiting: 0, working: 0 },
  };

  // Project pulse - what's active vs. neglected (Phase G2).
  try {
    const rows = pulse().listPulses();
    for (const p of rows) {
      ctx.projects.openTodos += Number(p.openTodos) || 0;
      if (p.state === "neglected") ctx.projects.neglected.push(p);
      else if (p.state === "active") ctx.projects.active.push(p);
      else if (p.state === "idle") ctx.projects.idle.push(p);
    }
  } catch {
    /* pulse unavailable */
  }

  // GitHub overview - review requests / red CI (Phase I).
  try {
    const { overview } = github().getCached();
    if (overview && overview.configured) {
      ctx.github = {
        reviewRequested: overview.counts?.reviewRequested || 0,
        mine: overview.counts?.mine || 0,
        failingChecks: overview.counts?.failingChecks || 0,
        openIssues: overview.counts?.openIssues || 0,
      };
    }
  } catch {
    /* github unavailable */
  }

  // Dashboard runs since midnight - what ran / completed / failed.
  try {
    const since = startOfTodayIso();
    const rows = db.prepare("SELECT status FROM dashboard_runs WHERE started_at >= ?").all(since);
    for (const r of rows) {
      ctx.runs.total += 1;
      if (r.status === "completed") ctx.runs.completed += 1;
      else if (r.status === "error" || r.status === "killed") ctx.runs.failed += 1;
      else if (r.status === "running" || r.status === "spawning") ctx.runs.running += 1;
    }
  } catch {
    /* dashboard_runs unavailable */
  }

  // Agents waiting on the user right now (active sessions only).
  try {
    ctx.agents.waiting = db
      .prepare(
        "SELECT COUNT(*) AS c FROM agents a JOIN sessions s ON s.id = a.session_id WHERE s.status = 'active' AND a.status = 'waiting'"
      )
      .get().c;
    ctx.agents.working = db
      .prepare(
        "SELECT COUNT(*) AS c FROM agents a JOIN sessions s ON s.id = a.session_id WHERE s.status = 'active' AND a.status = 'working'"
      )
      .get().c;
  } catch {
    /* agents unavailable */
  }

  return ctx;
}

/** Compact human-readable fact list handed to the model (or shown as-is in the
 *  deterministic fallback). Bounded - a briefing prompt is small by design. */
function factLines(ctx, kind) {
  const lines = [];
  const p = ctx.projects;
  if (p.active.length) {
    lines.push(
      `Active projects: ${p.active
        .map((x) => x.projectName)
        .slice(0, 8)
        .join(", ")}.`
    );
  }
  if (p.neglected.length) {
    lines.push(
      `Neglected (no recent activity): ${p.neglected
        .map((x) => `${x.projectName} (${x.daysSinceActivity ?? "?"}d)`)
        .slice(0, 8)
        .join(", ")}.`
    );
  }
  if (p.openTodos > 0)
    lines.push(`${p.openTodos} open todo${p.openTodos === 1 ? "" : "s"} across notes.`);

  if (ctx.github) {
    const g = ctx.github;
    const bits = [];
    if (g.reviewRequested)
      bits.push(
        `${g.reviewRequested} PR${g.reviewRequested === 1 ? "" : "s"} awaiting your review`
      );
    if (g.failingChecks)
      bits.push(`${g.failingChecks} failing check${g.failingChecks === 1 ? "" : "s"}`);
    if (g.mine) bits.push(`${g.mine} open PR${g.mine === 1 ? "" : "s"} of yours`);
    if (g.openIssues) bits.push(`${g.openIssues} open issue${g.openIssues === 1 ? "" : "s"}`);
    if (bits.length) lines.push(`GitHub: ${bits.join(", ")}.`);
  }

  const r = ctx.runs;
  if (r.total > 0) {
    const runBits = [];
    if (r.completed) runBits.push(`${r.completed} completed`);
    if (r.failed) runBits.push(`${r.failed} failed`);
    if (r.running) runBits.push(`${r.running} still running`);
    lines.push(
      `Dashboard runs today: ${r.total} total${runBits.length ? ` (${runBits.join(", ")})` : ""}.`
    );
  }

  if (ctx.agents.waiting) {
    lines.push(
      `${ctx.agents.waiting} agent${ctx.agents.waiting === 1 ? "" : "s"} waiting on your input.`
    );
  }

  if (!lines.length) {
    lines.push(
      kind === "morning"
        ? "No notable overnight activity."
        : "A quiet day - nothing notable ran or changed."
    );
  }
  return lines;
}

// ── Composition ─────────────────────────────────────────────────────────────

function briefingSystem(kind) {
  return kind === "morning"
    ? "Write a short MORNING briefing (3–5 sentences, no markdown headings, no " +
        "bullet symbols) from the facts provided. Lead with what most deserves the " +
        "user's attention today. Do not invent anything beyond the facts; if the " +
        "facts are empty, give a brief honest 'nothing notable' briefing."
    : "Write a short END-OF-DAY summary (3–5 sentences, no markdown headings, no " +
        "bullet symbols) from the facts provided: what ran, what completed, what's " +
        "still waiting on the user, and anything neglected. Do not invent anything " +
        "beyond the facts.";
}

function deterministicBriefing(ctx, kind) {
  const opener = persona.line(
    kind === "morning" ? "Morning briefing." : "End-of-day summary.",
    kind === "morning"
      ? "Good morning, sir. Your briefing."
      : "That's the day, sir. A brief summary.",
    kind === "morning"
      ? "The day begins, little creator. The facts, cold and complete."
      : "The day is ash. Here is what it amounted to."
  );
  return [opener, ...factLines(ctx, kind)].join(" ");
}

/**
 * Compose a briefing's text (+ context). Uses the brain in Jarvis's persona when
 * a provider is configured; otherwise a deterministic, honest composition. Never
 * throws - a model error falls back to deterministic.
 */
async function compose(kind) {
  const ctx = assembleContext();
  const facts = factLines(ctx, kind).join("\n");
  // Persona variant that shaped this briefing (jarvis|ultron), null when the
  // persona is off - stored on the row so the history shows which voice spoke.
  const personaVariant = persona.isEnabled() ? persona.variant() : null;

  if (router.anyProviderConfigured()) {
    try {
      const result = await router.complete({
        prompt: `Facts:\n${facts}`,
        system: persona.applyToSystem(briefingSystem(kind)),
        taskClass: "standard",
        intent: "briefing",
      });
      const text = String(result.text || "").trim();
      if (text) return { text, provider: result.provider, personaVariant, ctx };
    } catch {
      /* fall through to deterministic */
    }
  }
  return { text: deterministicBriefing(ctx, kind), provider: null, personaVariant, ctx };
}

function titleFor(kind) {
  const date = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return kind === "morning" ? `Morning briefing - ${date}` : `End-of-day summary - ${date}`;
}

/**
 * Compose, persist, file-as-note, push, and broadcast one briefing.
 * @param {object} args
 * @param {"morning"|"evening"} args.kind
 * @param {string} [args.trigger] schedule|manual|voice (default manual)
 * @returns {Promise<object>} the persisted briefing row (with a `speech` field)
 */
async function runBriefing({ kind = "morning", trigger = "manual" } = {}) {
  const k = kind === "evening" ? "evening" : "morning";
  const { text, provider, personaVariant } = await compose(k);
  const speech = toSpeech(text);

  // File it as a markdown note too (Phase G1) so it's searchable / in Obsidian.
  let noteId = null;
  try {
    const note = notes().createNote({
      title: titleFor(k),
      body: text,
      tags: ["briefing", k],
      source: "briefing",
    });
    noteId = note ? note.id : null;
  } catch {
    /* notes unavailable - the briefing still persists + pushes */
  }

  const id = randomUUID();
  try {
    stmts.insertBriefing.run({
      id,
      kind: k,
      trigger,
      text,
      speech,
      provider: provider || null,
      note_id: noteId,
      persona: personaVariant || null,
    });
  } catch {
    /* persistence best-effort; still push + return the composed briefing */
  }

  const row = safeGet(id) || {
    id,
    kind: k,
    trigger,
    text,
    speech,
    provider: provider || null,
    note_id: noteId,
    persona: personaVariant || null,
    created_at: new Date().toISOString(),
  };

  // Push (category "briefings") deep-linked to the Briefings page.
  try {
    push()
      .sendPushToAll(db, titleFor(k), speech || text.slice(0, 180), "/briefings", "briefings")
      .catch(() => {});
  } catch {
    /* best-effort */
  }

  const b = broadcastFn();
  if (b) {
    try {
      b("briefing_created", row);
    } catch {
      /* best-effort */
    }
  }

  return row;
}

function safeGet(id) {
  try {
    return stmts.getBriefing.get(id) || null;
  } catch {
    return null;
  }
}

function listBriefings({ limit = 30, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 30)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    return stmts.listBriefings.all(safeLimit, safeOffset);
  } catch {
    return [];
  }
}

function latest(kind) {
  try {
    return stmts.latestBriefingByKind.get(kind) || null;
  } catch {
    return null;
  }
}

// ── Scheduling: a 60s tick on the shared scheduler ──────────────────────────

const LAST_FIRED_KEY = { morning: "briefing_last_morning", evening: "briefing_last_evening" };

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function schedMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function lastFired(kind) {
  try {
    const row = stmts.getSetting.get(LAST_FIRED_KEY[kind]);
    return row && row.value ? row.value : null;
  } catch {
    return null;
  }
}

function markFired(kind, stamp) {
  try {
    stmts.setSetting.run(LAST_FIRED_KEY[kind], stamp);
  } catch {
    /* best-effort */
  }
}

/**
 * One scheduler tick. For each enabled kind, fire it once today when the clock
 * has reached its configured time (within a grace window so a briefly-down
 * server catches up, but a long-down one doesn't fire a morning briefing at
 * night). Idempotent per day via the persisted last-fired stamp.
 */
async function tick() {
  const cfg = getConfig();
  const stamp = todayStamp();
  const now = nowMinutes();

  for (const kind of ["morning", "evening"]) {
    const c = cfg[kind];
    if (!c.enabled) continue;
    if (lastFired(kind) === stamp) continue; // already fired today
    const target = schedMinutes(c.time);
    if (now < target) continue; // not time yet
    if (now >= target + GRACE_MINUTES) {
      // Missed the window (server was down through it) - skip today so we don't
      // deliver a morning briefing at an odd hour; tomorrow fires normally.
      markFired(kind, stamp);
      continue;
    }
    markFired(kind, stamp); // mark BEFORE firing so a slow compose can't double-fire
    try {
      await runBriefing({ kind, trigger: "schedule" });
    } catch (err) {
      console.warn(`[briefings] scheduled ${kind} briefing failed:`, err?.message || err);
    }
  }
}

module.exports = {
  getConfig,
  setConfig,
  assembleContext,
  compose,
  runBriefing,
  listBriefings,
  latest,
  tick,
  DEFAULTS,
};
