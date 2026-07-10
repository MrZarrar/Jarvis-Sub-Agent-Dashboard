/**
 * @file routes/monday.js
 * @description HTTP surface for the Monday.com panel (Phase AD) - a deliberate
 * 1:1 clone of routes/github.js:
 *   GET    /api/monday                → the cached overview (instant).
 *   POST   /api/monday/refresh        → force a fresh poll now, return the overview.
 *   GET    /api/monday/config         → redacted config (hasToken, pollMinutes, doneLabel).
 *   PUT    /api/monday/config         → update config (token stays server-side).
 *   POST   /api/monday/items/:id/done → write-back minimum (AD §4, used by the
 *          AC Today board): set the item's status column to the done label,
 *          then re-poll so the cache/UI reflect it.
 *
 * The router reuses the Run router's loopback-Origin guard because /refresh and
 * /done hit the Monday API with a secret token and /config writes that secret -
 * a cross-site page must not be able to trigger either.
 *
 * @author Jarvis (Phase AD)
 */

const { Router } = require("express");
const { __sameOriginGuard } = require("./run");
const { broadcast } = require("../websocket");
const config = require("../lib/monday/config");
const service = require("../lib/monday/service");
const client = require("../lib/monday/client");
const { db } = require("../db");
const push = require("../lib/push");

const router = Router();
router.use(__sameOriginGuard);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Cached overview - served straight from SQLite.
router.get("/", (_req, res) => {
  const cached = service.getCached();
  const cfg = config.getConfig();
  res.json({
    overview: cached.overview,
    fetchedAt: cached.fetchedAt,
    error: cached.error,
    configured: cfg.enabled && Boolean(cfg.token),
  });
});

// Force a fresh poll (hits the Monday API). Broadcasts + pushes on delta.
router.post("/refresh", async (_req, res) => {
  try {
    const result = await service.pollOnce({ db, broadcast, push });
    res.json({
      overview: result.overview,
      fetchedAt: result.fetchedAt,
      error: result.error,
      configured: result.overview.configured,
    });
  } catch (err) {
    fail(res, 500, "EREFRESH", err.message || String(err));
  }
});

// Redacted config for the panel's inline config editor.
router.get("/config", (_req, res) => {
  res.json({ config: config.redactedConfig() });
});

// Update config. Body is a partial patch: { enabled?, token?, pollMinutes?, doneLabel? }.
// The token is never echoed back - only the redacted view.
router.put("/config", (req, res) => {
  try {
    config.updateConfig(req.body || {});
    res.json({ config: config.redactedConfig() });
  } catch (err) {
    fail(res, 400, "EBADCONFIG", err.message || String(err));
  }
});

// Mark an item done. The status column id comes from the cached item (we never
// trust the client to name an arbitrary column), then a fresh poll updates the
// cache and broadcasts the delta.
router.post("/items/:id/done", async (req, res) => {
  const itemId = String(req.params.id);
  const boardId = req.body && req.body.boardId ? String(req.body.boardId) : null;
  const { overview } = service.getCached();
  const lists = [overview.mine, overview.dueToday, overview.overdue, overview.recent];
  const item = lists
    .flatMap((l) => l || [])
    .find((i) => i.id === itemId && (!boardId || i.boardId === boardId));
  if (!item) return fail(res, 404, "ENOTFOUND", "item not found in the cached overview");
  if (!item.statusColumnId)
    return fail(res, 400, "ENOSTATUS", "item has no status column to mark done");
  try {
    await client.markDone({
      boardId: item.boardId,
      itemId: item.id,
      columnId: item.statusColumnId,
    });
    const result = await service.pollOnce({ db, broadcast, push });
    res.json({ ok: true, overview: result.overview });
  } catch (err) {
    fail(res, 502, "EMARKDONE", err.message || String(err));
  }
});

module.exports = router;
