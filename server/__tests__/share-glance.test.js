/**
 * @file share-glance.test.js
 * @description Phase T tests: the PWA share-target capture route and the
 * assistant glance endpoint (widget JSON). Boots a real server on a scratch
 * DB, mirrors api.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const TEST_DB = path.join(os.tmpdir(), `dashboard-share-test-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;

const { createApp, startServer } = require("../index");
const { db } = require("../db");

let server;
let BASE;

function rawFetch(urlPath, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.unlinkSync(TEST_DB);
    fs.unlinkSync(TEST_DB + "-wal");
    fs.unlinkSync(TEST_DB + "-shm");
  } catch {
    /* ignore */
  }
});

describe("POST /api/share-target", () => {
  it("captures shared text+url into the assistant inbox and redirects to /notes", async () => {
    const res = await rawFetch("/api/share-target", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "title=Article&text=worth+reading&url=https%3A%2F%2Fexample.com%2Fa",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, "/notes");
    const row = db
      .prepare("SELECT * FROM assistant_captures WHERE source = 'share' ORDER BY created_at DESC")
      .get();
    assert.ok(row, "capture row written");
    assert.match(row.text, /Article/);
    assert.match(row.text, /https:\/\/example\.com\/a/);
    assert.equal(row.status, "inbox");
  });

  it("rejects an empty share", async () => {
    const res = await rawFetch("/api/share-target", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "text=",
    });
    assert.equal(res.status, 400);
  });
});

describe("GET /api/assistant/glance", () => {
  it("requires an assistant token for external callers", async () => {
    // No Origin header and no token → 401, same policy as /ask.
    const res = await rawFetch("/api/assistant/glance");
    assert.equal(res.status, 401);
  });

  it("returns the compact widget shape for first-party callers", async () => {
    const res = await rawFetch("/api/assistant/glance", {
      headers: { Origin: BASE },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.runs && typeof res.body.runs.live === "number");
    assert.ok(typeof res.body.runs.waitingOnPermission === "number");
    assert.ok(res.body.agents && typeof res.body.agents.working === "number");
    assert.ok(typeof res.body.sessions.active === "number");
    assert.ok("percentUsed" in res.body.window && "resetsAt" in res.body.window);
    // The share test above filed one capture into the inbox.
    assert.ok(res.body.captures >= 1);
    assert.ok(res.body.at);
  });
});
