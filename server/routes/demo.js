/**
 * @file routes/demo.js
 * @description Demo mode - one switch that fills the dashboard with dummy
 * data so every surface can be viewed without live agents:
 *   GET  /api/demo       → { active }
 *   POST /api/demo/start → seed the demo set (idempotent - resets first)
 *   POST /api/demo/stop  → remove every demo row/file
 *
 * The demo set = the stable seed fixtures from scripts/seed.js (solo +
 * deeply-nested sessions), plus a "Demo Crew" session holding one agent per
 * Ops-Room character (sleuth/code monkey/robot/scholar/commander/strategist/
 * waiting/completed/error), plus a "Demo tasks" vault note whose `- [ ]`
 * lines feed the Today board and mission deck. Everything is tagged with
 * `demo-` ids / the Demo-tasks title, so stop() removes exactly what start()
 * created and never touches user data. No scheduled prompts are seeded - a
 * pending schedule would be armed by the real scheduler and launch a run.
 */

const { Router } = require("express");
const { __sameOriginGuard } = require("./run");
const { db, stmts } = require("../db");
const { broadcast } = require("../websocket");
const notes = require("../lib/notes");
const seed = require("../../scripts/seed");

const CREW_SESSION_ID = "demo-crew-0001-0001-0001-000000000001";
const DEMO_NOTE_TITLE = "Demo tasks";
const DEMO_SESSION_IDS = [...seed.FIXTURE_SESSION_IDS, CREW_SESSION_ID];

// One agent per Ops-Room casting + one per kanban lane.
// [id-suffix, name, subagent_type, status, task, current_tool, ended]
const CREW = [
  [
    "sherlock",
    "Sherlock",
    "Explore",
    "working",
    "Scouting the codebase for auth flows",
    "WebSearch",
    false,
  ],
  [
    "monkey",
    "Code Monkey",
    "general-purpose",
    "working",
    "Typing out the new endpoint",
    "Write",
    false,
  ],
  ["robot", "Ops Robot", "general-purpose", "working", "Running the test suite", "Bash", false],
  ["scholar", "The Scholar", "Explore", "working", "Reading ARCHITECTURE.md", "Read", false],
  [
    "strategist",
    "The Strategist",
    "Plan",
    "working",
    "Drafting the implementation plan",
    "TodoWrite",
    false,
  ],
  [
    "blocked",
    "Needs Your Call",
    "general-purpose",
    "waiting",
    "Waiting for permission to push",
    null,
    false,
  ],
  ["done", "Finished Job", "general-purpose", "completed", "Shipped the hotfix", null, true],
  [
    "crashed",
    "Crashed Job",
    "general-purpose",
    "error",
    "Hit an unrecoverable merge conflict",
    null,
    true,
  ],
];

const DEMO_TODOS = [
  "Check this task off from the mission deck",
  "Edit this task on the Today board",
  "Add your own task with the quick-add box",
  "Visit the Ops Room tab to meet the crew",
];

function isActive() {
  return seed.sessionExists(CREW_SESSION_ID);
}

function findDemoNote() {
  try {
    return notes.listNotes({ limit: 500 }).find((n) => n.title === DEMO_NOTE_TITLE) || null;
  } catch {
    return null;
  }
}

function startDemo() {
  stopDemo(); // reset so re-starts always yield fresh timestamps
  seed.seedFixtures();

  const tx = db.transaction(() => {
    stmts.insertSession.run(
      CREW_SESSION_ID,
      "Demo Crew: One of Everything",
      "active",
      "/home/dev/demo-crew",
      "claude-fable-5",
      null
    );
    const mainId = "demo-crew-0001-main";
    stmts.insertAgent.run(
      mainId,
      CREW_SESSION_ID,
      "Demo Commander",
      "main",
      null,
      "working",
      "Delegating the demo missions",
      null,
      null
    );
    db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Task", mainId);

    for (const [suffix, name, subType, status, task, tool, ended] of CREW) {
      const id = `demo-crew-0001-${suffix}`;
      stmts.insertAgent.run(
        id,
        CREW_SESSION_ID,
        name,
        "subagent",
        subType,
        status,
        task,
        mainId,
        null
      );
      if (tool) db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run(tool, id);
      if (ended)
        db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      stmts.insertEvent.run(
        CREW_SESSION_ID,
        id,
        status === "error" ? "Stop" : tool ? "PreToolUse" : "Notification",
        tool,
        status === "error"
          ? `${name} stopped with an error`
          : tool
            ? `Using tool: ${tool}`
            : `${name}: ${task}`,
        JSON.stringify({ demo: true })
      );
    }
  });
  tx();

  if (!findDemoNote()) {
    notes.createNote({
      title: DEMO_NOTE_TITLE,
      tags: ["demo"],
      body: DEMO_TODOS.map((t) => `- [ ] ${t}`).join("\n"),
    });
  }

  broadcast("session_created", { id: CREW_SESSION_ID, status: "active" });
  broadcast("note_changed", { title: DEMO_NOTE_TITLE });
}

function stopDemo() {
  const placeholders = DEMO_SESSION_IDS.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM events WHERE session_id IN (${placeholders})`).run(...DEMO_SESSION_IDS);
    db.prepare(`DELETE FROM agents WHERE session_id IN (${placeholders})`).run(...DEMO_SESSION_IDS);
    db.prepare(`DELETE FROM token_usage WHERE session_id IN (${placeholders})`).run(
      ...DEMO_SESSION_IDS
    );
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...DEMO_SESSION_IDS);
  });
  tx();

  const note = findDemoNote();
  if (note) {
    try {
      notes.deleteNote(note.id);
    } catch {
      /* file already gone */
    }
  }

  broadcast("session_updated", { id: CREW_SESSION_ID, status: "completed" });
  broadcast("note_changed", { title: DEMO_NOTE_TITLE });
}

const router = Router();
router.use(__sameOriginGuard);

router.get("/", (_req, res) => {
  res.json({ active: isActive() });
});

router.post("/start", (_req, res) => {
  try {
    startDemo();
    res.json({ ok: true, active: true });
  } catch (err) {
    res.status(500).json({ error: { code: "EDEMO", message: err.message || String(err) } });
  }
});

router.post("/stop", (_req, res) => {
  try {
    stopDemo();
    res.json({ ok: true, active: false });
  } catch (err) {
    res.status(500).json({ error: { code: "EDEMO", message: err.message || String(err) } });
  }
});

module.exports = router;
