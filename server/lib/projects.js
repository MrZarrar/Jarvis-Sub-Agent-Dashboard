/**
 * @file projects.js
 * @description Projects (Phase F) - the dashboard-native organizing dimension
 * across sessions, dashboard-spawned runs, and chats. Deliberately separate
 * from Claude.ai's own "Projects" feature: this module never talks to any
 * Anthropic API and knows nothing about it.
 *
 * Auto-association has two independent mechanisms, matching how each kind of
 * activity enters the dashboard:
 *   - Hook-ingested sessions and dashboard-spawned runs both carry a `cwd`.
 *     `matchProjectForCwd` finds the project whose `project_paths` entry is
 *     the longest matching path-prefix of that cwd (a project may span
 *     multiple repos, hence a one-to-many table rather than a single column).
 *   - Chats have no cwd (they're plain conversations), so they can only be
 *     tagged explicitly via the API - there is no auto-association for them.
 *
 * All write paths here are best-effort and never throw into a caller that
 * has a live session/run/chat to persist - association is a side benefit,
 * matching the pattern in dashboard-runs.js / claude-swap.js.
 */

const { randomUUID } = require("node:crypto");
const { db, stmts } = require("../db");
const notes = require("./notes");

const STATUSES = new Set(["active", "paused", "done"]);
const RECENT_LIMIT = 8;

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function cleanString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────

function createProject({ name, description, status, repoPath, notesDir } = {}) {
  const trimmedName = cleanString(name);
  if (!trimmedName) throw makeErr("EBADINPUT", "name is required");
  const validStatus = STATUSES.has(status) ? status : "active";
  const trimmedRepoPath = cleanString(repoPath);
  const id = randomUUID();
  stmts.insertProject.run({
    id,
    name: trimmedName,
    description: cleanString(description),
    status: validStatus,
    repo_path: trimmedRepoPath,
    notes_dir: cleanString(notesDir),
  });
  if (trimmedRepoPath) {
    stmts.insertProjectPath.run(randomUUID(), id, trimmedRepoPath);
    rescanUnassociated();
  }
  return stmts.getProject.get(id);
}

function getProject(id) {
  return stmts.getProject.get(id) || null;
}

function listProjects({ status } = {}) {
  if (status && STATUSES.has(status)) return stmts.listProjectsByStatus.all(status);
  return stmts.listProjects.all();
}

function updateProject(id, patch = {}) {
  const existing = stmts.getProject.get(id);
  if (!existing) return null;
  const status = STATUSES.has(patch.status) ? patch.status : null;
  stmts.updateProject.run(
    cleanString(patch.name),
    cleanString(patch.description),
    status,
    cleanString(patch.repoPath),
    cleanString(patch.notesDir),
    id
  );
  // A repoPath change/addition on the project row itself should also become
  // a matchable path if it isn't already one of this project's paths.
  const newPath = cleanString(patch.repoPath);
  if (newPath) {
    const already = stmts.listProjectPathsByProject.all(id).some((p) => p.repo_path === newPath);
    if (!already) {
      stmts.insertProjectPath.run(randomUUID(), id, newPath);
      rescanUnassociated();
    }
  }
  return stmts.getProject.get(id);
}

// Deleting a project un-tags (never deletes) the activity it grouped - the
// project is an organizing label, not the system of record for that history.
const deleteProjectTx = db.transaction((id) => {
  stmts.clearProjectFromSessions.run(id);
  stmts.clearProjectFromRuns.run(id);
  stmts.clearProjectFromChats.run(id);
  // Drop the project's pulse row (Phase G2) - it's derived data, safe to delete.
  try {
    stmts.deletePulse.run(id);
  } catch {
    /* older DB without project_pulse - ignore */
  }
  return stmts.deleteProject.run(id).changes > 0; // project_paths cascade via FK
});

function deleteProject(id) {
  return deleteProjectTx(id);
}

// ── Paths (cwd → project matching) ──────────────────────────────────────

function listProjectPaths(projectId) {
  return stmts.listProjectPathsByProject.all(projectId);
}

function addProjectPath(projectId, repoPath) {
  const project = stmts.getProject.get(projectId);
  if (!project) throw makeErr("ENOTFOUND", "project not found");
  const trimmed = cleanString(repoPath);
  if (!trimmed) throw makeErr("EBADINPUT", "repoPath is required");
  const id = randomUUID();
  stmts.insertProjectPath.run(id, projectId, trimmed);
  const backfilled = rescanUnassociated();
  return { path: stmts.getProjectPath.get(id), backfilled };
}

function removeProjectPath(projectId, pathId) {
  const row = stmts.getProjectPath.get(pathId);
  if (!row || row.project_id !== projectId) return false;
  stmts.deleteProjectPath.run(pathId);
  return true;
}

/** True when `cwd` equals `repoPath` or sits inside it (path-boundary aware,
 *  not just a raw string prefix - "/repo-2" must not match repoPath "/repo"). */
function isPathPrefixMatch(cwd, repoPath) {
  if (!cwd || !repoPath) return false;
  if (cwd === repoPath) return true;
  const base = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return cwd.startsWith(base);
}

/** Longest matching project_paths prefix for a cwd, or null. Longest wins so
 *  a project scoped to a subdirectory of another project's repo takes
 *  precedence over the parent. */
function matchProjectForCwd(cwd) {
  if (!cwd) return null;
  try {
    let best = null;
    for (const row of stmts.listAllProjectPaths.all()) {
      if (isPathPrefixMatch(cwd, row.repo_path)) {
        if (!best || row.repo_path.length > best.repo_path.length) best = row;
      }
    }
    return best ? best.project_id : null;
  } catch {
    return null;
  }
}

/** Explicit id (if it names a real project) wins; otherwise fall back to a
 *  cwd-based guess. Used at run-spawn time - "tag the active project" means
 *  the project whose path matches this run's cwd when the caller didn't pick
 *  one explicitly. */
function resolveProjectId({ explicitId, cwd } = {}) {
  try {
    if (explicitId && stmts.getProject.get(explicitId)) return explicitId;
  } catch {
    /* fall through to cwd match */
  }
  return matchProjectForCwd(cwd);
}

/** Best-effort, never throws: called right after a new hook-ingested session
 *  is created so its cwd gets a project tag from the very first row. */
function associateSessionByCwd(sessionId, cwd) {
  try {
    const projectId = matchProjectForCwd(cwd);
    if (projectId) stmts.setSessionProject.run(projectId, sessionId);
  } catch {
    /* association is a side benefit, never a blocker */
  }
}

/** Best-effort, never throws: called at dashboard-run spawn time. */
function associateRunByCwd(runId, cwd, explicitId) {
  try {
    const projectId = resolveProjectId({ explicitId, cwd });
    if (projectId) stmts.setRunProject.run(projectId, runId);
  } catch {
    /* ignore */
  }
}

/** Re-scan every session/run that has a cwd but no project yet against the
 *  current project_paths table. Called whenever a path is added so
 *  pre-existing history retroactively associates instead of only new
 *  activity going forward (one project may span repos, and the matching
 *  repo might already have history before its path was registered). */
function rescanUnassociated() {
  let sessions = 0;
  let runs = 0;
  try {
    for (const row of stmts.unassociatedSessionsWithCwd.all()) {
      const projectId = matchProjectForCwd(row.cwd);
      if (projectId && stmts.setSessionProject.run(projectId, row.id).changes > 0) sessions++;
    }
  } catch {
    /* best effort */
  }
  try {
    for (const row of stmts.unassociatedRunsWithCwd.all()) {
      const projectId = matchProjectForCwd(row.cwd);
      if (projectId && stmts.setRunProject.run(projectId, row.id).changes > 0) runs++;
    }
  } catch {
    /* best effort */
  }
  return { sessions, runs };
}

// ── Rollups (Projects card grid + detail view) ──────────────────────────

function getProjectRollup(projectId, { limit = RECENT_LIMIT } = {}) {
  // Note counts are additive (Phase G1) and guarded so an older DB without the
  // notes table still returns a rollup.
  let noteCount = 0;
  let recentNotes = [];
  try {
    const projectNotes = notes.listNotes({
      projectId,
      limit: Number.MAX_SAFE_INTEGER,
      includeSensitive: false,
    });
    noteCount = projectNotes.length;
    recentNotes = projectNotes.slice(0, limit);
  } catch {
    noteCount = 0;
    recentNotes = [];
  }
  return {
    sessionCount: stmts.countSessionsByProject.get(projectId).count,
    runCount: stmts.countRunsByProject.get(projectId).count,
    chatCount: stmts.countChatsByProject.get(projectId).count,
    noteCount,
    recentSessions: stmts.recentSessionsByProject.all(projectId, limit),
    recentRuns: stmts.recentRunsByProject.all(projectId, limit),
    recentChats: stmts.recentChatsByProject.all(projectId, limit),
    recentNotes,
    lastActivityAt:
      stmts.lastActivityByProject.get(projectId, projectId, projectId).last_activity || null,
  };
}

module.exports = {
  STATUSES,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  listProjectPaths,
  addProjectPath,
  removeProjectPath,
  matchProjectForCwd,
  resolveProjectId,
  associateSessionByCwd,
  associateRunByCwd,
  rescanUnassociated,
  getProjectRollup,
};
