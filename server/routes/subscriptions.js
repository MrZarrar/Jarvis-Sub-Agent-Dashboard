/**
 * @file Express router for the subscriptions / finance tracker (Phase AE).
 * Thin HTTP layer over server/lib/finance.js (which owns validation, date
 * math, the summary rollup and the paste-to-parse brain assist):
 *   GET    /api/subscriptions          - list all (active first, by renewal)
 *   POST   /api/subscriptions          - create { name, amount, ... }
 *   PUT    /api/subscriptions/:id      - partial update
 *   DELETE /api/subscriptions/:id      - delete
 *   GET    /api/subscriptions/summary  - per-currency burn + upcoming renewals
 *   POST   /api/subscriptions/parse    - { text } → candidate subscriptions
 *                                        (confirm-before-save; nothing persisted)
 */

const { Router } = require("express");
const finance = require("../lib/finance");

const router = Router();

router.get("/", (_req, res) => {
  res.json({ subscriptions: finance.list() });
});

router.get("/summary", (_req, res) => {
  res.json(finance.summary());
});

router.post("/", (req, res) => {
  const out = finance.create(req.body || {});
  if (!out.ok) {
    return res.status(400).json({ error: { code: "INVALID_SUBSCRIPTION", message: out.error } });
  }
  res.status(201).json({ subscription: out.row });
});

router.put("/:id", (req, res) => {
  const out = finance.update(req.params.id, req.body || {});
  if (!out.ok) {
    return res.status(out.notFound ? 404 : 400).json({
      error: { code: out.notFound ? "NOT_FOUND" : "INVALID_SUBSCRIPTION", message: out.error },
    });
  }
  res.json({ subscription: out.row });
});

router.delete("/:id", (req, res) => {
  const out = finance.remove(req.params.id);
  if (!out.ok) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: out.error } });
  }
  res.json({ ok: true });
});

router.post("/parse", async (req, res) => {
  const text = req.body && typeof req.body.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    return res.status(400).json({ error: { code: "EMPTY_TEXT", message: "text is required" } });
  }
  const out = await finance.parseCandidates(text);
  res.json(out);
});

module.exports = router;
