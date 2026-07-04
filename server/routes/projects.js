/**
 * @file projects.js
 * @description CRUD for Projects (Phase F) — the dashboard-native organizing
 * dimension over sessions/runs/chats. Backed by server/lib/projects.js.
 * Plain CRUD with no process-spawning or outbound-API side effects, so this
 * sits behind only the global host/CORS/token guards (server/index.js),
 * same posture as routes/alerts.js and routes/webhooks.js.
 *
 * Surface:
 *   GET    /api/projects                 — list (?status=active|paused|done)
 *   POST   /api/projects                 — create
 *   GET    /api/projects/:id             — one, with rollup (recent sessions/runs/chats)
 *   PATCH  /api/projects/:id             — edit (name/description/status/repoPath/notesDir)
 *   DELETE /api/projects/:id             — remove (un-tags its activity, never deletes it)
 *   GET    /api/projects/:id/paths       — list associated repo paths
 *   POST   /api/projects/:id/paths       — add a repo path (backfills matching history)
 *   DELETE /api/projects/:id/paths/:pathId
 */

const { Router } = require("express");
const projects = require("../lib/projects");
const pulse = require("../lib/brain/pulse");

const router = Router();

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}

function notFound(res, message = "project not found") {
  return res.status(404).json({ error: { code: "ENOTFOUND", message } });
}

router.get("/", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const items = projects.listProjects({ status }).map((p) => ({
    ...p,
    rollup: projects.getProjectRollup(p.id, { limit: 3 }),
  }));
  res.json({ items });
});

// Project pulse (Phase G2) — the working/neglected/completed tracker. Literal
// routes must precede "/:id". GET returns the current pulses (recomputed daily
// by the scheduler); POST forces an immediate recompute.
router.get("/pulse", (_req, res) => {
  res.json({ items: pulse.listPulses(), neglectDays: pulse.NEGLECT_DAYS });
});

router.post("/pulse/recompute", (_req, res) => {
  try {
    pulse.computeAllPulses();
    res.json({ items: pulse.listPulses(), neglectDays: pulse.NEGLECT_DAYS });
  } catch (err) {
    res.status(500).json({ error: { code: "EPULSE", message: err.message } });
  }
});

router.post("/", (req, res) => {
  const body = req.body || {};
  try {
    const project = projects.createProject({
      name: body.name,
      description: body.description,
      status: body.status,
      repoPath: body.repoPath,
      notesDir: body.notesDir,
    });
    res.status(201).json({ project });
  } catch (err) {
    return badRequest(res, err.code || "EBADREQUEST", err.message);
  }
});

router.get("/:id", (req, res) => {
  const project = projects.getProject(req.params.id);
  if (!project) return notFound(res);
  res.json({
    project,
    rollup: projects.getProjectRollup(project.id),
    paths: projects.listProjectPaths(project.id),
    pulse: pulse.getPulse(project.id),
  });
});

router.patch("/:id", (req, res) => {
  const body = req.body || {};
  const project = projects.updateProject(req.params.id, {
    name: body.name,
    description: body.description,
    status: body.status,
    repoPath: body.repoPath,
    notesDir: body.notesDir,
  });
  if (!project) return notFound(res);
  res.json({ project });
});

router.delete("/:id", (req, res) => {
  const removed = projects.deleteProject(req.params.id);
  if (!removed) return notFound(res);
  res.json({ ok: true });
});

router.get("/:id/paths", (req, res) => {
  const project = projects.getProject(req.params.id);
  if (!project) return notFound(res);
  res.json({ items: projects.listProjectPaths(project.id) });
});

router.post("/:id/paths", (req, res) => {
  const repoPath = typeof req.body?.repoPath === "string" ? req.body.repoPath : "";
  try {
    const { path, backfilled } = projects.addProjectPath(req.params.id, repoPath);
    res.status(201).json({ path, backfilled });
  } catch (err) {
    if (err.code === "ENOTFOUND") return notFound(res, err.message);
    return badRequest(res, err.code || "EBADREQUEST", err.message);
  }
});

router.delete("/:id/paths/:pathId", (req, res) => {
  const removed = projects.removeProjectPath(req.params.id, req.params.pathId);
  if (!removed) return notFound(res, "path not found on this project");
  res.json({ ok: true });
});

module.exports = router;
