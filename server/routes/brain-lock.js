const { Router } = require("express");
const brainLock = require("../lib/brain-lock");
const { __sameOriginGuard } = require("./run");

const router = Router();
router.use(__sameOriginGuard);

function sendError(res, err) {
  const status =
    err.code === "EBADPIN" || err.code === "EBADTIMEOUT"
      ? 400
      : err.code === "EINVALIDPIN"
        ? 401
        : err.code === "EBRAINLOCKOUT"
          ? 429
          : err.code === "ENOTCONFIGURED"
            ? 409
            : err.code === "EALREADYCONFIGURED"
              ? 409
              : 500;
  return res.status(status).json({
    error: {
      code: err.code || "EBRAINLOCK",
      message: err.message || "Brain lock request failed",
      ...(Number.isFinite(err.attemptsRemaining)
        ? { attemptsRemaining: err.attemptsRemaining }
        : {}),
      ...(Number.isFinite(err.retryAfterSeconds)
        ? { retryAfterSeconds: err.retryAfterSeconds }
        : {}),
    },
  });
}

router.get("/status", (req, res) => res.json(brainLock.status(req)));

router.post("/setup", async (req, res) => {
  try {
    const session = await brainLock.setup(req.body?.pin, req.body?.timeoutMinutes ?? 5);
    brainLock.setSessionCookie(req, res, session.token, session.timeoutMinutes);
    res
      .status(201)
      .json({ configured: true, unlocked: true, timeoutMinutes: session.timeoutMinutes });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/unlock", async (req, res) => {
  try {
    const session = await brainLock.unlock(req.body?.pin);
    brainLock.setSessionCookie(req, res, session.token, session.timeoutMinutes);
    res.json({ configured: true, unlocked: true, timeoutMinutes: session.timeoutMinutes });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/lock", (req, res) => {
  brainLock.lock(req);
  brainLock.clearSessionCookie(req, res);
  res.json({ locked: true });
});

router.put("/settings", (req, res) => {
  const auth = brainLock.authenticate(req);
  if (!auth.unlocked) {
    return res.status(423).json({ error: { code: "EBRAINLOCKED", message: "Brain locked" } });
  }
  try {
    const cfg = brainLock.updateSettings(req.body?.timeoutMinutes);
    brainLock.setSessionCookie(req, res, auth.token, cfg.timeout_minutes);
    res.json(brainLock.status(req));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
