/**
 * @file routes/briefings.js
 * @description REST surface for proactive Jarvis (Phase J): the briefing history,
 * an on-demand "run now" (used by the Briefings page and the "morning briefing"
 * voice intent), and the combined Phase-J config (briefing times, nudge rules,
 * and the JARVIS persona toggle).
 *
 * Running a briefing composes via the brain, files a note, and fires a push, so
 * this router reuses the Run router's loopback-Origin guard (same CSRF posture
 * as /api/run and /api/schedules) - a malicious page must not be able to trigger
 * pushes or write notes.
 *
 *   GET  /api/briefings              - recent briefings + latest per kind
 *   POST /api/briefings/run          - compose + persist + push { kind }
 *   GET  /api/briefings/config       - { morning, evening, nudges, persona }
 *   PUT  /api/briefings/config       - patch any of the above
 *
 * @author Jarvis (Phase J)
 */

const { Router } = require("express");
const briefings = require("../lib/briefings");
const nudges = require("../lib/nudges");
const persona = require("../lib/brain/persona");
const { __sameOriginGuard } = require("./run");

const router = Router();
router.use(__sameOriginGuard);

function fullConfig() {
  const b = briefings.getConfig();
  return {
    morning: b.morning,
    evening: b.evening,
    nudges: nudges.getConfig(),
    persona: persona.isEnabled(),
  };
}

router.get("/", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || "30"), 10);
  const offset = Number.parseInt(String(req.query.offset || "0"), 10);
  res.json({
    items: briefings.listBriefings({ limit, offset }),
    latest: {
      morning: briefings.latest("morning"),
      evening: briefings.latest("evening"),
    },
  });
});

router.post("/run", async (req, res) => {
  const kind = req.body && req.body.kind === "evening" ? "evening" : "morning";
  try {
    const row = await briefings.runBriefing({ kind, trigger: "manual" });
    res.status(201).json({ briefing: row });
  } catch (err) {
    res
      .status(500)
      .json({ error: { code: "BRIEFING_FAILED", message: err?.message || "failed to compose" } });
  }
});

router.get("/config", (_req, res) => {
  res.json({ config: fullConfig() });
});

router.put("/config", (req, res) => {
  const body = req.body || {};
  try {
    if (body.morning || body.evening) {
      briefings.setConfig({ morning: body.morning, evening: body.evening });
    }
    if (body.nudges && typeof body.nudges === "object") {
      nudges.setConfig(body.nudges);
    }
    if (body.persona !== undefined) {
      persona.setEnabled(Boolean(body.persona));
    }
    res.json({ config: fullConfig() });
  } catch (err) {
    res
      .status(400)
      .json({ error: { code: "INVALID_INPUT", message: err?.message || "invalid config" } });
  }
});

module.exports = router;
