/**
 * @file projects.test.js
 * @description Integration + unit tests for Projects (Phase F): route CRUD,
 * repo-path management with retroactive backfill, cwd-prefix auto-association
 * for hook-ingested sessions, and dashboard-run project tagging via
 * dashboard-runs.js. Uses Node's built-in test runner with a temp DB, mirroring
 * the pattern in session-name-rename.test.js / chat.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "projects-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const projectsLib = require("../lib/projects");
const dashboardRuns = require("../lib/dashboard-runs");

let server;
let BASE;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("POST /api/projects", () => {
  it("requires a name", async () => {
    const res = await req("POST", "/api/projects", { description: "no name" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "EBADINPUT");
  });

  it("creates a project, optionally registering repoPath as a project_paths row", async () => {
    const res = await req("POST", "/api/projects", {
      name: "Jarvis Dashboard",
      description: "The dashboard itself",
      repoPath: "/tmp/jarvis-repo",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.project.name, "Jarvis Dashboard");
    assert.equal(res.body.project.status, "active");
    assert.equal(res.body.project.repo_path, "/tmp/jarvis-repo");

    const paths = projectsLib.listProjectPaths(res.body.project.id);
    assert.equal(paths.length, 1);
    assert.equal(paths[0].repo_path, "/tmp/jarvis-repo");
  });
});

describe("GET /api/projects", () => {
  it("lists projects with a rollup on each row", async () => {
    const created = await req("POST", "/api/projects", { name: "Rollup Test" });
    const res = await req("GET", "/api/projects");
    assert.equal(res.status, 200);
    const row = res.body.items.find((p) => p.id === created.body.project.id);
    assert.ok(row, "created project appears in the list");
    assert.deepEqual(row.rollup.sessionCount, 0);
    assert.deepEqual(row.rollup.runCount, 0);
    assert.deepEqual(row.rollup.chatCount, 0);
    assert.equal(row.rollup.lastActivityAt, null);
  });

  it("filters by status", async () => {
    const created = await req("POST", "/api/projects", { name: "Paused Project" });
    await req("PATCH", `/api/projects/${created.body.project.id}`, { status: "paused" });
    const res = await req("GET", "/api/projects?status=paused");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.every((p) => p.status === "paused"));
    assert.ok(res.body.items.some((p) => p.id === created.body.project.id));
  });
});

describe("GET /api/projects/:id", () => {
  it("404s for an unknown project", async () => {
    const res = await req("GET", "/api/projects/does-not-exist");
    assert.equal(res.status, 404);
  });

  it("returns project + rollup + paths", async () => {
    const created = await req("POST", "/api/projects", {
      name: "Detail Test",
      repoPath: "/tmp/detail-repo",
    });
    const res = await req("GET", `/api/projects/${created.body.project.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.project.name, "Detail Test");
    assert.ok(res.body.rollup);
    assert.equal(res.body.paths.length, 1);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("edits fields and archives via status: done", async () => {
    const created = await req("POST", "/api/projects", { name: "Edit Me" });
    const id = created.body.project.id;

    const edited = await req("PATCH", `/api/projects/${id}`, {
      description: "now described",
      status: "done",
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.project.description, "now described");
    assert.equal(edited.body.project.status, "done");
  });

  it("404s for an unknown project", async () => {
    const res = await req("PATCH", "/api/projects/does-not-exist", { name: "x" });
    assert.equal(res.status, 404);
  });
});

describe("DELETE /api/projects/:id", () => {
  it("un-tags sessions/runs/chats instead of deleting them, then removes the project", async () => {
    const created = await req("POST", "/api/projects", { name: "Delete Me" });
    const projectId = created.body.project.id;

    // Directly tag a session and a chat with this project (bypassing the
    // cwd-matching path, which is covered elsewhere) to prove delete un-tags
    // rather than cascades onto real activity rows.
    const sessionId = randomUUID();
    stmts.insertSession.run(sessionId, "s", "completed", "/tmp/x", null, null);
    stmts.setSessionProject.run(projectId, sessionId);

    const chatId = randomUUID();
    stmts.insertChat.run({ id: chatId, title: "t", provider: null, model: null, project_id: null });
    db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(projectId, chatId);

    const res = await req("DELETE", `/api/projects/${projectId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(stmts.getProject.get(projectId), undefined);
    assert.equal(stmts.getSession.get(sessionId).project_id, null);
    assert.equal(stmts.getChat.get(chatId).project_id, null);
  });

  it("404s for an unknown project", async () => {
    const res = await req("DELETE", "/api/projects/does-not-exist");
    assert.equal(res.status, 404);
  });
});

describe("Project paths", () => {
  it("adds and removes a path, rejecting an unknown project", async () => {
    const created = await req("POST", "/api/projects", { name: "Paths Test" });
    const projectId = created.body.project.id;

    const bad = await req("POST", "/api/projects/does-not-exist/paths", {
      repoPath: "/tmp/whatever",
    });
    assert.equal(bad.status, 404);

    const added = await req("POST", `/api/projects/${projectId}/paths`, {
      repoPath: "/tmp/paths-test-repo",
    });
    assert.equal(added.status, 201);
    assert.ok(added.body.backfilled);
    assert.equal(typeof added.body.backfilled.sessions, "number");

    const list = await req("GET", `/api/projects/${projectId}/paths`);
    assert.equal(list.body.items.length, 1);

    const removed = await req("DELETE", `/api/projects/${projectId}/paths/${added.body.path.id}`);
    assert.equal(removed.status, 200);
    const listAfter = await req("GET", `/api/projects/${projectId}/paths`);
    assert.equal(listAfter.body.items.length, 0);
  });

  it("retroactively backfills existing sessions/runs when a matching path is added", async () => {
    const cwd = "/tmp/backfill-repo";
    const sessionId = randomUUID();
    stmts.insertSession.run(sessionId, "s", "completed", cwd, null, null);
    // No project association yet — matches the plan's requirement that
    // registering a path after the fact still associates prior history.
    assert.equal(stmts.getSession.get(sessionId).project_id, null);

    const created = await req("POST", "/api/projects", { name: "Backfill Test" });
    const added = await req("POST", `/api/projects/${created.body.project.id}/paths`, {
      repoPath: cwd,
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.backfilled.sessions, 1);
    assert.equal(stmts.getSession.get(sessionId).project_id, created.body.project.id);
  });
});

describe("cwd auto-association — hook-ingested sessions", () => {
  it("tags a brand-new hook-ingested session by matching its cwd", async () => {
    const cwd = "/tmp/hook-cwd-project";
    const created = await req("POST", "/api/projects", {
      name: "Hook CWD Project",
      repoPath: cwd,
    });

    const sessionId = randomUUID();
    const res = await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sessionId, cwd },
    });
    assert.equal(res.status, 200);

    const session = stmts.getSession.get(sessionId);
    assert.equal(session.project_id, created.body.project.id);
  });

  it("does not associate when no project_paths entry matches", async () => {
    const sessionId = randomUUID();
    const res = await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sessionId, cwd: "/tmp/totally-unmatched-cwd" },
    });
    assert.equal(res.status, 200);
    assert.equal(stmts.getSession.get(sessionId).project_id, null);
  });
});

describe("server/lib/projects.js — matching internals", () => {
  it("matches an exact cwd and a subdirectory, but not a sibling with a shared prefix", async () => {
    const created = await req("POST", "/api/projects", {
      name: "Prefix Match Project",
      repoPath: "/tmp/prefix-repo",
    });
    const id = created.body.project.id;

    assert.equal(projectsLib.matchProjectForCwd("/tmp/prefix-repo"), id);
    assert.equal(projectsLib.matchProjectForCwd("/tmp/prefix-repo/src"), id);
    assert.equal(projectsLib.matchProjectForCwd("/tmp/prefix-repo-2"), null);
    assert.equal(projectsLib.matchProjectForCwd("/tmp/unrelated"), null);
  });

  it("prefers the longest matching path when projects are nested", async () => {
    const parent = await req("POST", "/api/projects", {
      name: "Parent Repo",
      repoPath: "/tmp/nested-parent",
    });
    const child = await req("POST", "/api/projects", { name: "Child Package" });
    await req("POST", `/api/projects/${child.body.project.id}/paths`, {
      repoPath: "/tmp/nested-parent/packages/child",
    });

    assert.equal(
      projectsLib.matchProjectForCwd("/tmp/nested-parent/packages/child/src"),
      child.body.project.id
    );
    assert.equal(
      projectsLib.matchProjectForCwd("/tmp/nested-parent/packages/other"),
      parent.body.project.id
    );
  });

  it("resolveProjectId: an explicit valid id wins over a cwd match", async () => {
    const cwdProject = await req("POST", "/api/projects", {
      name: "CWD Wins Normally",
      repoPath: "/tmp/explicit-vs-cwd",
    });
    const explicitProject = await req("POST", "/api/projects", { name: "Explicit Override" });

    assert.equal(
      projectsLib.resolveProjectId({ cwd: "/tmp/explicit-vs-cwd" }),
      cwdProject.body.project.id
    );
    assert.equal(
      projectsLib.resolveProjectId({
        explicitId: explicitProject.body.project.id,
        cwd: "/tmp/explicit-vs-cwd",
      }),
      explicitProject.body.project.id
    );
    // An explicit id that doesn't name a real project falls back to the cwd match.
    assert.equal(
      projectsLib.resolveProjectId({ explicitId: "nonexistent", cwd: "/tmp/explicit-vs-cwd" }),
      cwdProject.body.project.id
    );
  });
});

describe("dashboard-runs.js — project tagging for spawned runs", () => {
  it("persists the resolved projectId from the handle onto the dashboard_runs row", async () => {
    const created = await req("POST", "/api/projects", { name: "Run Tag Project" });
    const runId = randomUUID();
    dashboardRuns.recordRun({
      id: runId,
      cwd: "/tmp/run-tag-cwd",
      mode: "headless",
      status: "completed",
      prompt: "test",
      // Mirrors run-spawner.js: projectId is already RESOLVED before recordRun
      // is called, not re-resolved here.
      projectId: created.body.project.id,
    });
    const row = dashboardRuns.getRun(runId);
    assert.equal(row.project_id, created.body.project.id);
  });

  it("leaves project_id null when the handle carries none", () => {
    const runId = randomUUID();
    dashboardRuns.recordRun({
      id: runId,
      cwd: "/tmp/no-project-cwd",
      mode: "headless",
      status: "completed",
      prompt: "test",
      projectId: null,
    });
    assert.equal(dashboardRuns.getRun(runId).project_id, null);
  });
});

describe("Chat project tagging (explicit-only, no cwd)", () => {
  it("POST /api/chat/chats accepts an optional projectId", async () => {
    const created = await req("POST", "/api/projects", { name: "Chat Project" });
    const res = await req("POST", "/api/chat/chats", {
      title: "Tagged chat",
      projectId: created.body.project.id,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.chat.project_id, created.body.project.id);
  });

  it("PATCH /api/chat/chats/:id can set or clear projectId independently of title", async () => {
    const created = await req("POST", "/api/projects", { name: "Chat Project 2" });
    const chat = await req("POST", "/api/chat/chats", { title: "Untagged" });
    assert.equal(chat.body.chat.project_id, null);

    const tagged = await req("PATCH", `/api/chat/chats/${chat.body.chat.id}`, {
      projectId: created.body.project.id,
    });
    assert.equal(tagged.status, 200);
    assert.equal(tagged.body.chat.project_id, created.body.project.id);
    assert.equal(tagged.body.chat.title, "Untagged", "title untouched by a projectId-only patch");

    const cleared = await req("PATCH", `/api/chat/chats/${chat.body.chat.id}`, {
      projectId: null,
    });
    assert.equal(cleared.body.chat.project_id, null);
  });
});
