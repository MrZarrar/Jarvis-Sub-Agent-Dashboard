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
    assert.equal(
      missions.listMissions().some((mission) => mission.id === "imported:codex-thread-1"),
      false,
      "imported history belongs in Sessions unless explicitly requested"
    );
    assert.equal(
      missions
        .listMissions({ includeImported: true })
        .some((mission) => mission.id === "imported:codex-thread-1"),
      true
    );
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

  it("keeps interrupted and blocked missions recoverable", () => {
    assert.equal(missions.missionStatusForTurn("interrupted"), "cancelled");
    db.prepare(
      `INSERT INTO missions
       (id, title, prompt, domain, interaction, status, owner_provider, owner_model_tier, native_thread_id)
       VALUES ('blocked-1', 'Blocked', 'Continue me', 'personal', 'durable_mission', 'blocked', 'codex', 'standard', 'thread-blocked')`
    ).run();
    const mission = missions.getMission("blocked-1");
    assert.equal(mission.controls.interrupt, true);
    assert.equal(mission.controls.retry, true);
    assert.equal(mission.controls.steer, true);

    const statuses = [];
    const unsubscribe = missions.onMissionStatus((changed) => statuses.push(changed.status));
    missions.patchMission("blocked-1", { status: "running" });
    missions.patchMission("blocked-1", { status: "completed" });
    unsubscribe();
    assert.deepEqual(statuses, ["running", "completed"]);

    db.prepare(
      `INSERT INTO mission_artifacts
       (id, mission_id, provider, kind, uri, native_id)
       VALUES ('artifact-1', 'blocked-1', 'codex', 'file_change', '/tmp/result.txt', 'item-1')`
    ).run();
    assert.equal(missions.missionDetail("blocked-1").artifacts[0].uri, "/tmp/result.txt");
  });
});
