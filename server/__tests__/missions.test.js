const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "missions-test-"));
process.env.DASHBOARD_DB_PATH = path.join(tmp, "dashboard.db");

const { db } = require("../db");
const missions = require("../lib/missions");

after(() => {
  missions.start();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("provider-neutral missions", () => {
  it("projects imported Codex history into a controllable mission detail", () => {
    db.prepare(
      `INSERT INTO sessions (id, name, status, provider, cwd, model)
       VALUES (?, ?, 'completed', 'codex', ?, ?)`
    ).run("codex-thread-1", "Imported task", "/tmp/project", "gpt-5.6-terra");

    const detail = missions.missionDetail("imported:codex-thread-1");
    assert.equal(detail.mission.native_thread_id, "thread-1");
    assert.equal(detail.mission.imported, true);
    assert.equal(detail.mission.controls.steer, true);
    assert.deepEqual(detail.events, []);
  });

  it("enforces Sol fan-out, depth, and one-writer-per-workspace limits", () => {
    assert.throws(
      () =>
        missions.validateAssignments(
          Array.from({ length: 5 }, (_, i) => ({ prompt: `task ${i}` }))
        ),
      /at most four/
    );
    assert.throws(
      () =>
        missions.validateAssignments([
          { prompt: "code one", domain: "development", workspace: "/tmp/repo" },
          { prompt: "code two", domain: "development", workspace: "/tmp/repo" },
        ]),
      /one code-writing child/
    );
    assert.equal(missions.missionMetrics().total, 0);
  });
});
