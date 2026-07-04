/**
 * @file Express router for managing push notifications, providing endpoints to retrieve the VAPID public key, subscribe/unsubscribe to push notifications, and send push notifications to all subscribers. It interacts with the database to store subscription details and uses a push library to send notifications.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { getPublicKey, sendPushToAll, PUSH_CATEGORIES, PUSH_CATEGORY_KEYS } = require("../lib/push");
const { db } = require("../db");

const router = Router();

router.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: getPublicKey() });
});

// Per-category delivery switches (permission requests / run completions /
// waiting agents / briefings). Stored server-side so muting a category applies
// to every device. A category with no row defaults to enabled.
router.get("/categories", (_req, res) => {
  const rows = db.prepare("SELECT category, enabled FROM notification_prefs").all();
  const stored = new Map(rows.map((r) => [r.category, r.enabled !== 0]));
  const categories = PUSH_CATEGORIES.map(({ key, label }) => ({
    key,
    label,
    enabled: stored.has(key) ? stored.get(key) : true,
  }));
  res.json({ categories });
});

router.put("/categories/:category", (req, res) => {
  const { category } = req.params;
  if (!PUSH_CATEGORY_KEYS.includes(category)) {
    return res.status(400).json({ error: { message: "Unknown category" } });
  }
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: { message: "`enabled` must be a boolean" } });
  }
  db.prepare(
    `INSERT INTO notification_prefs (category, enabled, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(category) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run(category, req.body.enabled ? 1 : 0);
  res.json({ ok: true, category, enabled: req.body.enabled });
});

router.post("/subscribe", (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: { message: "Missing required fields" } });
  }
  db.prepare(
    "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)"
  ).run(endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

router.delete("/subscribe", (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: { message: "Missing endpoint" } });
  }
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  res.json({ ok: true });
});

router.post("/send", async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: { message: "Missing title or body" } });
  }
  try {
    // `result` tells the caller which surfaces actually fired:
    //   { native: true|false, pushed: <count>, failed: <count> }
    // so a silent "no subscribers, no Electron host" no-op stops looking like
    // success on the client side.
    const result = await sendPushToAll(db, title, body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
