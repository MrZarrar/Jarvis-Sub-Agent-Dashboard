/**
 * @file Tests for the Phase-O notification inbox: the notify facade (persist +
 * dedupe/coalesce + category mute) and the /api/notifications read routes.
 * @author Jarvis (Phase O)
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const http = require("http");

const TEST_DB = path.join(os.tmpdir(), `notifications-test-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;

const { createApp, startServer } = require("../index");
const notify = require("../lib/notify");
const { db } = require("../db");

let server;
let BASE;

function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const bodyString = options.body ? JSON.stringify(options.body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(bodyString ? { "Content-Length": Buffer.byteLength(bodyString) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    require("fs").unlinkSync(TEST_DB);
  } catch {}
});

describe("notify facade", () => {
  it("persists a row with data+url and reports it unread", async () => {
    const out = notify.notify({
      category: "run_completions",
      title: "Run failed in demo",
      body: "Run abc12345 in demo failed — exit 1.",
      url: "/run?runId=abc",
      data: { runId: "abc" },
      source: "test",
    });
    assert.ok(out.id);
    assert.equal(out.coalesced, false);
    const res = await request("/api/notifications");
    assert.equal(res.status, 200);
    assert.ok(res.body.unread >= 1);
    const row = res.body.notifications.find((n) => n.id === out.id);
    assert.ok(row);
    assert.equal(row.data.url, "/run?runId=abc");
    assert.equal(row.data.runId, "abc");
    assert.equal(row.read_at, null);
  });

  it("coalesces an unread row with the same category+dedupeKey", () => {
    const a = notify.notify({
      category: "waiting_agents",
      title: "Agent waiting",
      body: "first",
      dedupeKey: "waiting:agent-1",
    });
    const b = notify.notify({
      category: "waiting_agents",
      title: "Agent still waiting",
      body: "second",
      dedupeKey: "waiting:agent-1",
    });
    assert.equal(b.id, a.id);
    assert.equal(b.coalesced, true);
    const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(a.id);
    assert.equal(row.title, "Agent still waiting");
    // A read row does NOT coalesce - a fresh spell gets a fresh row.
    notify.markRead(a.id);
    const c = notify.notify({
      category: "waiting_agents",
      title: "Agent waiting again",
      dedupeKey: "waiting:agent-1",
    });
    assert.notEqual(c.id, a.id);
  });

  it("is a full no-op for a muted category", () => {
    db.prepare(
      "INSERT INTO notification_prefs (category, enabled) VALUES ('github', 0) ON CONFLICT(category) DO UPDATE SET enabled = 0"
    ).run();
    const out = notify.notify({ category: "github", title: "CI red" });
    assert.equal(out.muted, true);
    assert.equal(out.id, null);
    const rows = db.prepare("SELECT * FROM notifications WHERE category = 'github'").all();
    assert.equal(rows.length, 0);
  });
});

describe("read routes", () => {
  it("marks one read, then read-all clears the rest", async () => {
    const one = notify.notify({ category: "briefings", title: "Morning briefing ready" });
    const res1 = await request(`/api/notifications/${one.id}/read`, { method: "POST", body: {} });
    assert.equal(res1.status, 200);
    const res404 = await request(`/api/notifications/${one.id}/read`, { method: "POST", body: {} });
    assert.equal(res404.status, 404); // already read

    notify.notify({ category: "briefings", title: "Evening briefing ready" });
    const resAll = await request("/api/notifications/read-all", { method: "POST", body: {} });
    assert.equal(resAll.status, 200);
    const after = await request("/api/notifications?unread=1");
    assert.equal(after.body.unread, 0);
    assert.equal(after.body.notifications.length, 0);
  });
});
