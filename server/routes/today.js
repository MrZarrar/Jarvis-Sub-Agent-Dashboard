/**
 * @file routes/today.js
 * @description HTTP surface for the Today board (Phase AC):
 *   GET  /api/today             → the aggregated board (todos, Monday lanes,
 *        today's schedules, waiting agents, today's runs). No new storage -
 *        see server/lib/today.js.
 *   POST /api/today/todos/check → check/uncheck one note todo (rewrites the
 *        `- [ ]` line in the markdown file via the notes write path).
 *   POST   /api/today/todos → add a todo (appends to today's daily note,
 *          creating the YYYY-MM-DD note on first add).
 *   PUT    /api/today/todos → edit one todo's text in place.
 *   DELETE /api/today/todos → remove one todo line from its note.
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

// Shared error shape for the todo write endpoints below.
function sendTodoError(res, code, err) {
  const message = err.message || String(err);
  const status = /not found/.test(message) ? 404 : /required/.test(message) ? 400 : 500;
  res.status(status).json({ error: { code, message } });
}

// Body: { text } - appends `- [ ] text` to today's daily note.
router.post("/todos", (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: { code: "EBADINPUT", message: "text is required" } });
  }
  try {
    res.json({ ok: true, ...today.addTodo({ text }) });
  } catch (err) {
    sendTodoError(res, "EADD", err);
  }
});

// Body: { noteId, line, text, newText } - rewrites the todo's text in place.
router.put("/todos", (req, res) => {
  const { noteId, line, text, newText } = req.body || {};
  if (!noteId || typeof text !== "string" || typeof newText !== "string" || !newText.trim()) {
    return res
      .status(400)
      .json({ error: { code: "EBADINPUT", message: "noteId, text and newText are required" } });
  }
  try {
    res.json({ ok: true, ...today.editTodo({ noteId, line, text, newText }) });
  } catch (err) {
    sendTodoError(res, "EEDIT", err);
  }
});

// Body: { noteId, line, text } - removes the todo line from its note.
router.delete("/todos", (req, res) => {
  const { noteId, line, text } = req.body || {};
  if (!noteId || typeof text !== "string" || !text.trim()) {
    return res
      .status(400)
      .json({ error: { code: "EBADINPUT", message: "noteId and text are required" } });
  }
  try {
    res.json({ ok: true, ...today.deleteTodo({ noteId, line, text }) });
  } catch (err) {
    sendTodoError(res, "EDELETE", err);
  }
});

module.exports = router;
