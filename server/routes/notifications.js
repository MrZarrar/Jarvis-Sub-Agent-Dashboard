/**
 * @file routes/notifications.js
 * @description REST surface for the Phase-O notification inbox (§3.2). The
 * rows are written by server/lib/notify.js (the one facade every producer
 * routes through); this router only reads and flips read state.
 *
 *   GET  /api/notifications?unread=1&limit=50 - { notifications, unread }
 *   POST /api/notifications/:id/read          - { ok }
 *   POST /api/notifications/read-all          - { ok, marked }
 *
 * Read state changes broadcast `notification_read` so every open device's
 * badge syncs live.
 *
 * @author Jarvis (Phase O)
 */

const { Router } = require("express");
const notify = require("../lib/notify");

const router = Router();

router.get("/", (req, res) => {
  const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
  const notifications = notify.list({ unreadOnly, limit: req.query.limit });
  res.json({ notifications, unread: notify.unreadCount() });
});

router.post("/read-all", (req, res) => {
  const marked = notify.markAllRead();
  res.json({ ok: true, marked });
});

router.post("/:id/read", (req, res) => {
  const ok = notify.markRead(String(req.params.id || ""));
  if (!ok) return res.status(404).json({ error: "not found or already read" });
  res.json({ ok: true });
});

module.exports = router;
