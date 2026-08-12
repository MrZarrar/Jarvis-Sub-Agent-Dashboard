/**
 * @file brain/pulse.js
 * @description Project "pulse" (Phase G2, §G2.5) - the working/neglected/
 * completed tracker. A daily brain task (armed via the shared scheduler, NOT a
 * second scheduler) recomputes one row per project into `project_pulse` from:
 *   - last session/run/chat activity (projects.getProjectRollup),
 *   - open note todos (unchecked `- [ ]` across the project's notes),
 *   - the project's own status field.
 *
 * The judgment is DETERMINISTIC (not model-hallucinated) so it's trustworthy and
 * works with zero providers configured - matching the plan's "deterministic, not
 * brain-hallucinated" rule for nudges. The brain tier is reserved for prose
 * briefings (Phase J), which read this same artifact. Fail-safe throughout.
 *
 * @author Jarvis (Phase G)
 */

const { stmts } = require("../../db");
const projects = require("../projects");
const notes = require("../notes");

const NEGLECT_DAYS = Number(process.env.JARVIS_NEGLECT_DAYS) || 7;
const DAY_MS = 86_400_000;

/** Count unchecked `- [ ]` todos across a project's notes, and track the most
 *  recent note update (notes ARE activity for the neglect judgment). */
function scanNotes(projectId) {
  let open = 0;
  let latest = null;
  try {
    for (const note of notes.listNotes({ projectId, limit: 500, includeSensitive: false })) {
      if (note.updatedAt && (!latest || note.updatedAt > latest)) latest = note.updatedAt;
      const full = notes.getNote(note.id, { includeSensitive: false });
      if (!full || typeof full.body !== "string") continue;
      const matches = full.body.match(/^\s*-\s*\[\s*\]\s+/gm);
      if (matches) open += matches.length;
    }
  } catch {
    /* best-effort */
  }
  return { open, latest };
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function humanAge(days) {
  if (days == null) return "no activity yet";
  if (days <= 0) return "active today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** Compute (and persist) one project's pulse. Returns the pulse row shape. */
function computeProjectPulse(project) {
  const rollup = safeRollup(project.id);
  const { open: openTodos, latest: latestNote } = scanNotes(project.id);
  // Activity = the most recent of session/run/chat activity OR a note update -
  // a project you're actively noting in isn't neglected even with no runs.
  const rollupActivity = rollup ? rollup.lastActivityAt : null;
  const lastActivityAt =
    !rollupActivity || (latestNote && latestNote > rollupActivity)
      ? latestNote || rollupActivity
      : rollupActivity;
  const days = daysSince(lastActivityAt);

  let state;
  if (project.status === "done") state = "completed";
  else if (project.status === "paused") state = "paused";
  else if (lastActivityAt == null) state = "idle";
  else if (days != null && days >= NEGLECT_DAYS) state = "neglected";
  else state = "active";

  const summary = buildSummary(state, days, openTodos);
  const row = {
    project_id: project.id,
    state,
    summary,
    days_since_activity: days,
    open_todos: openTodos,
    last_activity_at: lastActivityAt,
  };
  try {
    stmts.upsertPulse.run(row);
  } catch {
    /* persistence is a side benefit; still return the computed row */
  }
  return row;
}

function buildSummary(state, days, openTodos) {
  const todoPart = openTodos > 0 ? ` · ${openTodos} open todo${openTodos === 1 ? "" : "s"}` : "";
  switch (state) {
    case "completed":
      return `Done${openTodos > 0 ? ` · ${openTodos} todo${openTodos === 1 ? "" : "s"} still open` : ""}`;
    case "paused":
      return `Paused · last activity ${humanAge(days)}${todoPart}`;
    case "idle":
      return `No activity yet${todoPart}`;
    case "neglected":
      return `Neglected - no activity in ${days} days${todoPart}`;
    default:
      return `Active · last activity ${humanAge(days)}${todoPart}`;
  }
}

function safeRollup(projectId) {
  try {
    return projects.getProjectRollup(projectId, { limit: 1 });
  } catch {
    return null;
  }
}

/** Recompute pulse for every project. Returns the list of computed rows. */
function computeAllPulses() {
  const out = [];
  let list = [];
  try {
    list = projects.listProjects();
  } catch {
    list = [];
  }
  const live = new Set();
  for (const p of list) {
    live.add(p.id);
    out.push(computeProjectPulse(p));
  }
  // Prune pulse rows for projects that no longer exist.
  try {
    for (const row of stmts.listPulse.all()) {
      if (!live.has(row.project_id)) stmts.deletePulse.run(row.project_id);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

function getPulse(projectId) {
  try {
    return stmts.getPulse.get(projectId) || null;
  } catch {
    return null;
  }
}

/** All pulses joined with project name/status, most-neglected first. */
function listPulses() {
  let rows = [];
  try {
    rows = stmts.listPulse.all();
  } catch {
    rows = [];
  }
  return rows
    .map((r) => {
      const project = projects.getProject(r.project_id);
      if (!project) return null;
      return {
        projectId: r.project_id,
        projectName: project.name,
        projectStatus: project.status,
        state: r.state,
        summary: r.summary,
        daysSinceActivity: r.days_since_activity,
        openTodos: r.open_todos,
        lastActivityAt: r.last_activity_at,
        computedAt: r.computed_at,
      };
    })
    .filter(Boolean);
}

module.exports = { computeAllPulses, computeProjectPulse, getPulse, listPulses, NEGLECT_DAYS };
