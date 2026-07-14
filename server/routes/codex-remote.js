const { Router } = require("express");
const remote = require("../lib/codex-remote");
const { __sameOriginGuard } = require("./run");
const { enabled } = require("../lib/features");

const router = Router();
router.use(__sameOriginGuard);
router.use((_req, res, next) => {
  if (!enabled("mobile_codex_remote")) {
    return res
      .status(503)
      .json({ error: { code: "EFEATUREDISABLED", message: "Codex Remote controls are disabled" } });
  }
  next();
});

router.get("/status", async (_req, res) => res.json(await remote.status()));

for (const action of ["start", "stop", "pair"]) {
  router.post(`/${action}`, async (_req, res) => {
    try {
      res.json(await remote[action]());
    } catch (error) {
      res.status(503).json({
        error: { code: "EREMOTE", message: error.detail || error.message || String(error) },
      });
    }
  });
}

module.exports = router;
