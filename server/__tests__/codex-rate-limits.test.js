const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

process.env.DASHBOARD_DB_PATH = path.join(os.tmpdir(), `dashboard-codex-limits-${process.pid}.db`);

const { __formatCodexRateLimits } = require("../routes/analytics");

describe("Codex rate-limit formatter", () => {
  it("keeps the native five-hour and weekly windows distinct", () => {
    const result = __formatCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 20, resetsAt: 1_784_111_200, windowDurationMins: 300 },
        secondary: { usedPercent: 65, resetsAt: 1_784_716_000, windowDurationMins: 10_080 },
      },
    });
    assert.deepEqual(result.fiveHour, {
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: "2026-07-15T10:26:40.000Z",
    });
    assert.deepEqual(result.weekly, {
      usedPercent: 65,
      remainingPercent: 35,
      resetsAt: "2026-07-22T10:26:40.000Z",
    });
  });

  it("does not substitute a weekly-only limit for the five-hour bucket", () => {
    const result = __formatCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 34, resetsAt: 1_784_710_127, windowDurationMins: 10_080 },
      },
    });
    assert.equal(result.fiveHour, null);
    assert.equal(result.weekly.remainingPercent, 66);
  });
});
