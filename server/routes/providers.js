const { Router } = require("express");
const { capabilities } = require("../lib/provider-capabilities");

const router = Router();

router.get("/capabilities", async (_req, res) => {
  try {
    res.json(await capabilities());
  } catch (error) {
    res
      .status(503)
      .json({ error: { code: "EDIAGNOSTICS", message: error?.message || String(error) } });
  }
});

module.exports = router;
