/**
 * @file skills.js
 * @description Skills API (Phase H). Skill definitions are markdown files on
 * disk (server/lib/skills/store.js, same file-first philosophy as notes);
 * execution goes through server/lib/skills/engine.js, which can run shell
 * commands and spawn agent processes - so, like /api/run and /api/schedules,
 * this router sits behind the Run router's loopback-Origin guard (a malicious
 * page must not be able to trigger a skill).
 *
 * Surface:
 *   GET    /api/skills                - list skill definitions
 *   GET    /api/skills/config         - { dir, default }
 *   PUT    /api/skills/config         - set the skills directory
 *   GET    /api/skills/runs           - run history (?skillId=)
 *   GET    /api/skills/runs/:runId    - one run (with live step progress)
 *   POST   /api/skills/runs/:runId/cancel - cancel a running skill
 *   GET    /api/skills/:id            - one skill (raw file + parsed)
 *   POST   /api/skills                - create (raw markdown+frontmatter body)
 *   PUT    /api/skills/:id            - update (raw markdown+frontmatter body)
 *   DELETE /api/skills/:id            - delete
 *   POST   /api/skills/:id/run        - execute { params?, confirmText? }
 *
 * `phone` steps deep-link a push notification to `/skills?phoneRun=<runId>` -
 * the client reads that query param and renders the Shortcuts hand-off link
 * (see engine.js's runPhoneStep doc comment for why it isn't a direct
 * `shortcuts://` URL in the push payload itself).
 */

const { Router } = require("express");
const store = require("./../lib/skills/store");
const engine = require("./../lib/skills/engine");
const { __sameOriginGuard: sameOriginGuard } = require("./run");

const router = Router();
router.use(sameOriginGuard);

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}
function notFound(res, message = "skill not found") {
  return res.status(404).json({ error: { code: "ENOTFOUND", message } });
}

// ── Library ──────────────────────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.json({ items: store.listSkills() });
});

router.get("/config", (_req, res) => {
  res.json({ dir: store.getSkillsDir(), default: store.defaultSkillsDir() });
});

router.put("/config", (req, res) => {
  const dir = typeof req.body?.dir === "string" ? req.body.dir : "";
  try {
    const resolved = store.setSkillsDir(dir);
    res.json({ dir: resolved, default: store.defaultSkillsDir() });
  } catch (err) {
    return badRequest(res, "EBADDIR", err.message);
  }
});

// ── Run history (before "/:id" so "runs" is never treated as a skill id) ───
router.get("/runs", (req, res) => {
  const skillId = typeof req.query.skillId === "string" ? req.query.skillId : null;
  const limit = Number.parseInt(String(req.query.limit || "100"), 10);
  const offset = Number.parseInt(String(req.query.offset || "0"), 10);
  res.json({ items: engine.listRuns({ skillId, limit, offset }) });
});

router.get("/runs/:runId", (req, res) => {
  const run = engine.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: { code: "ENOTFOUND", message: "run not found" } });
  res.json({ run });
});

router.post("/runs/:runId/cancel", (req, res) => {
  const ok = engine.cancelRun(req.params.runId);
  if (!ok) {
    return res
      .status(404)
      .json({ error: { code: "ENOTFOUND", message: "run not found or not running" } });
  }
  res.json({ ok: true });
});

// ── CRUD ─────────────────────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const skill = store.getSkill(req.params.id);
  if (!skill) return notFound(res);
  res.json({ skill });
});

router.post("/", (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw : "";
  if (!raw.trim()) return badRequest(res, "EBADINPUT", "raw markdown content is required");
  try {
    const skill = store.createSkill(raw);
    res.status(201).json({ skill });
  } catch (err) {
    return badRequest(res, err.code || "ECREATE", err.message);
  }
});

router.put("/:id", (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw : "";
  if (!raw.trim()) return badRequest(res, "EBADINPUT", "raw markdown content is required");
  try {
    const skill = store.updateSkill(req.params.id, raw);
    if (!skill) return notFound(res);
    res.json({ skill });
  } catch (err) {
    return badRequest(res, err.code || "EUPDATE", err.message);
  }
});

router.delete("/:id", (req, res) => {
  const removed = store.deleteSkill(req.params.id);
  if (!removed) return notFound(res);
  res.json({ ok: true });
});

// ── Execution ────────────────────────────────────────────────────────────
router.post("/:id/run", (req, res) => {
  const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
  const confirmText = typeof req.body?.confirmText === "string" ? req.body.confirmText : null;
  try {
    const run = engine.runSkill({ skillId: req.params.id, params, trigger: "manual", confirmText });
    res.status(201).json({ run });
  } catch (err) {
    const status = err.code === "ENOTFOUND" ? 404 : err.code === "ECONFIRM" ? 409 : 400;
    res.status(status).json({ error: { code: err.code || "ERUN", message: err.message } });
  }
});

module.exports = router;
