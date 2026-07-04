/**
 * @file routes/github.js
 * @description HTTP surface for the GitHub dev-workflow panel (Phase I):
 *   GET    /api/github          → the cached cross-repo overview (instant).
 *   POST   /api/github/refresh  → force a fresh poll now, return the overview.
 *   GET    /api/github/config   → redacted config (repos, hasPat, pollMinutes).
 *   PUT    /api/github/config   → update config (PAT stays server-side).
 *
 * The router reuses the Run router's loopback-Origin guard because /refresh
 * spawns the `gh` CLI and /config writes a secret (PAT) — a cross-site page must
 * not be able to trigger either. Same posture as /api/run and /api/schedules;
 * a same-origin browser fetch and a no-Origin CLI both pass.
 *
 * @author Jarvis (Phase I)
 */

const { Router } = require("express");
const { __sameOriginGuard } = require("./run");
const { broadcast } = require("../websocket");
const config = require("../lib/github/config");
const service = require("../lib/github/service");
const client = require("../lib/github/client");
const { db } = require("../db");
const push = require("../lib/push");

const router = Router();
router.use(__sameOriginGuard);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Cached overview — served straight from SQLite, plus the current mode so the
// UI can explain an unconfigured / CI-unknown (PAT-mode) state honestly.
router.get("/", (_req, res) => {
  const cached = service.getCached();
  const cfg = config.getConfig();
  res.json({
    overview: cached.overview,
    fetchedAt: cached.fetchedAt,
    error: cached.error,
    mode: client.authMode(cfg),
    configured: cfg.enabled && cfg.repos.length > 0,
  });
});

// Force a fresh poll (spawns gh / hits REST). Broadcasts + pushes on delta.
router.post("/refresh", async (_req, res) => {
  try {
    const result = await service.pollOnce({ db, broadcast, push });
    res.json({
      overview: result.overview,
      fetchedAt: result.fetchedAt,
      error: result.error,
      mode: result.overview.mode,
      configured: result.overview.configured,
    });
  } catch (err) {
    fail(res, 500, "EREFRESH", err.message || String(err));
  }
});

// Redacted config for the Settings / GitHub-page config editor.
router.get("/config", (_req, res) => {
  res.json({ config: config.redactedConfig() });
});

// Update config. Body is a partial patch: { enabled?, pat?, repos?, pollMinutes? }.
// The PAT is never echoed back — only the redacted view.
router.put("/config", (req, res) => {
  try {
    config.updateConfig(req.body || {});
    res.json({ config: config.redactedConfig() });
  } catch (err) {
    fail(res, 400, "EBADCONFIG", err.message || String(err));
  }
});

module.exports = router;
