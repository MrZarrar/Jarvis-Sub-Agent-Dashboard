/**
 * @file routes/today.js
 * @description HTTP surface for the Today board (Phase AC):
 *   GET  /api/today             → the aggregated board (todos, Monday lanes,
 *        today's schedules, waiting agents, today's runs). No new storage -
 *        see server/lib/today.js.
 *   POST /api/today/todos/check → check/uncheck one note todo (rewrites the
 *        `- [ ]` line in the markdown file via the notes write path).
 *
 * The check endpoint writes files, so the router reuses the Run router's
 * loopback-Origin guard - same posture as /api/notes' mutating routes.
 * Checking a Monday item is POST /api/monday/items/:id/done (Phase AD).
 *
 * @author Jarvis (Phase AC)
 */

const { Router } = require("express");
const { __sameOriginGuard } = require("./run");
const today = require("../lib/today");

const router = Router();
router.use(__sameOriginGuard);

router.get("/", (_req, res) => {
  res.json(today.getToday());
});

// Body: { noteId, line, text, checked? } - line+text pin the exact todo; if the
// note changed since the board loaded the todo is re-found by text.
router.post("/todos/check", (req, res) => {
  const { noteId, line, text, checked } = req.body || {};
  if (!noteId || typeof text !== "string" || !text.trim()) {
    return res
      .status(400)
      .json({ error: { code: "EBADINPUT", message: "noteId and text are required" } });
  }
  try {
    const result = today.checkTodo({ noteId, line, text, checked: checked !== false });
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err.message || String(err);
    const status = /not found/.test(message) ? 404 : 500;
    res.status(status).json({ error: { code: "ECHECK", message } });
  }
});

module.exports = router;
