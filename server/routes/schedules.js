/**
 * @file schedules.js
 * @description CRUD for scheduled & chained prompts (Phase L). Backed by
 * server/lib/scheduler.js. Because firing a schedule can spawn a `claude`
 * process, this router reuses the Run router's loopback-Origin guard (same CSRF
 * posture as /api/run) - a malicious page must not be able to queue runs.
 *
 * Surface (kept stable for later phases that build on it - D intent, H skills):
 *   GET    /api/schedules            - list (?status=pending|fired|cancelled|failed)
 *   POST   /api/schedules            - create
 *   GET    /api/schedules/:id        - one
 *   PATCH  /api/schedules/:id        - edit a pending schedule
 *   DELETE /api/schedules/:id        - cancel (?cascade=1 cancels dependents)
 */

const { Router } = require("express");
const scheduler = require("../lib/scheduler");
const { __sameOriginGuard } = require("./run");

const router = Router();
router.use(__sameOriginGuard);

router.get("/", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const limit = Number.parseInt(String(req.query.limit || "100"), 10);
  const offset = Number.parseInt(String(req.query.offset || "0"), 10);
  const items = scheduler.listSchedules({ status, limit, offset });
  res.json({ items, maxChainDepth: scheduler.MAX_CHAIN_DEPTH });
});

router.post("/", (req, res) => {
  const body = req.body || {};
  try {
    const row = scheduler.createSchedule({
      label: typeof body.label === "string" ? body.label : null,
      prompt: body.prompt,
      targetKind: body.targetKind,
      targetOpts: body.targetOpts && typeof body.targetOpts === "object" ? body.targetOpts : {},
      triggerKind: body.triggerKind,
      fireAt: body.fireAt,
      triggerRunId: body.triggerRunId,
      statusFilter: body.statusFilter,
      chainDepth: Number.isFinite(body.chainDepth) ? body.chainDepth : 0,
      recurrence:
        typeof body.recurrence === "string" && body.recurrence.trim()
          ? body.recurrence.trim()
          : null,
      domain: typeof body.domain === "string" ? body.domain : "personal",
      ownerProvider: typeof body.ownerProvider === "string" ? body.ownerProvider : null,
      modelTier: typeof body.modelTier === "string" ? body.modelTier : null,
      workspace: typeof body.workspace === "string" ? body.workspace : null,
      agentRole: typeof body.agentRole === "string" ? body.agentRole : null,
      approvalPolicy: typeof body.approvalPolicy === "string" ? body.approvalPolicy : "never",
      sandboxPolicy: typeof body.sandboxPolicy === "string" ? body.sandboxPolicy : "read-only",
      threadStrategy: typeof body.threadStrategy === "string" ? body.threadStrategy : "new_thread",
      notificationPolicy:
        typeof body.notificationPolicy === "string" ? body.notificationPolicy : "all",
      overlapPolicy: typeof body.overlapPolicy === "string" ? body.overlapPolicy : "skip",
      missedRunPolicy: typeof body.missedRunPolicy === "string" ? body.missedRunPolicy : "run_once",
      retryLimit: Number.isFinite(body.retryLimit) ? body.retryLimit : 0,
      timeoutSeconds: Number.isFinite(body.timeoutSeconds) ? body.timeoutSeconds : 1800,
    });
    res.status(201).json({ schedule: row });
  } catch (err) {
    const status = err.code === "ECHAINDEPTH" ? 409 : 400;
    res.status(status).json({ error: { code: err.code || "EBADREQUEST", message: err.message } });
  }
});

router.get("/:id", (req, res) => {
  const row = scheduler.getSchedule(req.params.id);
  if (!row)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "schedule not found" } });
  res.json({ schedule: row });
});

router.patch("/:id", (req, res) => {
  const body = req.body || {};
  const row = scheduler.editSchedule(req.params.id, {
    label: typeof body.label === "string" ? body.label : undefined,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    fireAt: typeof body.fireAt === "string" ? body.fireAt : undefined,
    statusFilter: typeof body.statusFilter === "string" ? body.statusFilter : undefined,
  });
  if (!row) {
    return res
      .status(404)
      .json({ error: { code: "ENOTFOUND", message: "schedule not found or not editable" } });
  }
  res.json({ schedule: row });
});

router.delete("/:id", (req, res) => {
  const cascade = req.query.cascade === "1" || req.query.cascade === "true";
  const cancelled = scheduler.cancelSchedule(req.params.id, {
    cascade,
    reason: "cancelled by user",
  });
  if (cancelled === 0) {
    return res
      .status(404)
      .json({ error: { code: "ENOTFOUND", message: "schedule not found or not pending" } });
  }
  res.json({ ok: true, cancelled });
});

module.exports = router;
