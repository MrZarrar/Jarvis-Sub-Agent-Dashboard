const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nextOccurrence,
  startScheduler,
  stopScheduler,
  registerDueCallback,
} = require("../lib/scheduler");
const features = require("../lib/features");

describe("Agentic OS scheduler policy", () => {
  it("advances supported recurring mission intervals deterministically", () => {
    const start = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(
      nextOccurrence("RRULE:FREQ=HOURLY;INTERVAL=2", start),
      new Date(Date.parse(start) + 7_200_000).toISOString()
    );
  });

  it("rejects recurrence syntax the scheduler cannot execute", () => {
    assert.throws(() => nextOccurrence("RRULE:FREQ=MONTHLY", new Date().toISOString()), /supports/);
  });

  it("keeps rollout flags default-on and explicitly disableable", () => {
    const name = "JARVIS_FEATURE_CODEX_SCHEDULES";
    const previous = process.env[name];
    try {
      delete process.env[name];
      assert.equal(features.enabled("codex_schedules"), true);
      process.env[name] = "off";
      assert.equal(features.enabled("codex_schedules"), false);
    } finally {
      if (previous == null) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("fires completion chains when a watched mission completes", async () => {
    let missionListener;
    let fired = false;
    let persisted = false;
    const row = {
      id: "schedule-1",
      status: "pending",
      status_filter: "success",
      target_kind: "test-mission-chain",
      recurrence: null,
    };
    const stmts = {
      listPendingSchedules: { all: () => [] },
      listPendingSchedulesForRun: {
        all: (id) => (id === "mission-1" ? [row] : []),
      },
      getSchedule: { get: () => row },
      updateScheduleFired: {
        run: () => {
          persisted = true;
          return { changes: 1 };
        },
      },
    };

    startScheduler({
      db: {},
      stmts,
      broadcast: () => {},
      runs: { onRunStatus: () => () => {} },
      missions: {
        onMissionStatus(listener) {
          missionListener = listener;
          return () => {
            missionListener = null;
          };
        },
      },
    });
    registerDueCallback("test-mission-chain", async () => {
      fired = true;
      return {};
    });

    missionListener({ id: "mission-1", status: "completed" });
    await new Promise((resolve) => setImmediate(resolve));
    stopScheduler();

    assert.equal(fired, true);
    assert.equal(persisted, true);
    assert.equal(missionListener, null);
  });
});
