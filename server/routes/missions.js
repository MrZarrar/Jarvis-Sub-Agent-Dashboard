/** Provider-neutral mission API. */

const { Router } = require("express");
const missions = require("../lib/missions");
const { __sameOriginGuard } = require("./run");

const router = Router();
router.use(__sameOriginGuard);

function sendError(res, error) {
  const status = error?.code === "ENOTFOUND" ? 404 : error?.code === "EUNSUPPORTED" ? 409 : 400;
  res
    .status(status)
    .json({ error: { code: error?.code || "EMISSION", message: error?.message || String(error) } });
}

router.get("/", (req, res) => {
  res.json({
    items: missions.listMissions({
      status: typeof req.query.status === "string" ? req.query.status : null,
      domain: typeof req.query.domain === "string" ? req.query.domain : null,
      limit: req.query.limit,
      offset: req.query.offset,
    }),
  });
});

router.post("/", async (req, res) => {
  try {
    const mission = await missions.createMission(req.body || {});
    res.status(201).json({ mission });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/metrics", (_req, res) => {
  res.json(missions.missionMetrics());
});

router.get("/:id", (req, res) => {
  const detail = missions.missionDetail(req.params.id);
  if (!detail)
    return sendError(res, Object.assign(new Error("mission not found"), { code: "ENOTFOUND" }));
  res.json(detail);
});

router.get("/:id/events", (req, res) => {
  if (!missions.getMission(req.params.id)) {
    return sendError(res, Object.assign(new Error("mission not found"), { code: "ENOTFOUND" }));
  }
  res.json({ items: missions.missionEvents(req.params.id, req.query) });
});

router.post("/:id/steer", async (req, res) => {
  try {
    res.json({ mission: await missions.steerMission(req.params.id, req.body?.message) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/interrupt", async (req, res) => {
  try {
    res.json({ mission: await missions.interruptMission(req.params.id) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/retry", async (req, res) => {
  try {
    res.status(201).json({ mission: await missions.retryMission(req.params.id, req.body || {}) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/approval", async (req, res) => {
  try {
    const approvalId = req.body?.approvalId;
    if (typeof approvalId !== "string")
      throw Object.assign(new Error("approvalId is required"), { code: "EBADAPPROVAL" });
    res.json({
      mission: await missions.resolveApproval(req.params.id, approvalId, req.body || {}),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/fork", async (req, res) => {
  try {
    res.status(201).json({ mission: await missions.forkMission(req.params.id, req.body || {}) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/archive", async (req, res) => {
  try {
    res.json({ mission: await missions.archiveMission(req.params.id) });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
