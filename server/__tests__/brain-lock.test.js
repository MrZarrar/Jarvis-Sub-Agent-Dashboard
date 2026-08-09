const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-brain-lock-"));
process.env.DASHBOARD_DB_PATH = path.join(TEST_DIR, "dashboard.db");
process.env.DASHBOARD_TOKEN = "outer-dashboard-token";
process.env.DASHBOARD_ALLOWED_HOSTS = "jarvis.test.ts.net";
process.env.JARVIS_TEST_BRAIN_LOCK = "1";

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const { isBrainSocketAuthorized, canReceiveBrainData } = require("../websocket");

let server;
let base;
let sessionCookie;

async function start() {
  server = await startServer(createApp(), 0);
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  if (!server) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  server = null;
}

async function request(urlPath, { token = true, cookie, headers = {}, ...options } = {}) {
  return fetch(`${base}${urlPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      origin: "http://127.0.0.1:4820",
      ...(token ? { "x-dashboard-token": "outer-dashboard-token" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  });
}

before(start);
after(async () => {
  await stop();
  db.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.DASHBOARD_DB_PATH;
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_ALLOWED_HOSTS;
  delete process.env.JARVIS_TEST_BRAIN_LOCK;
});

describe("Brain PIN Lock", () => {
  it("keeps dashboard-token authentication independent", async () => {
    const response = await request("/api/brain-lock/status", { token: false });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "EUNAUTHORIZED");
  });

  it("requires exactly four digits at setup", async () => {
    for (const pin of ["123", "12345", "12a4", 1234]) {
      const response = await request("/api/brain-lock/setup", {
        method: "POST",
        body: JSON.stringify({ pin }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "EBADPIN");
    }
  });

  it("stores a salted scrypt hash and issues a localhost session cookie", async () => {
    const response = await request("/api/brain-lock/setup", {
      method: "POST",
      body: JSON.stringify({ pin: "2468", timeoutMinutes: 5 }),
    });
    assert.equal(response.status, 201);
    sessionCookie = response.headers.get("set-cookie");
    assert.match(sessionCookie, /^jarvis_brain_session=/);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Strict/i);
    assert.doesNotMatch(sessionCookie, /; Secure/i);

    const row = db.prepare("SELECT * FROM brain_lock_config WHERE id = 1").get();
    assert.ok(row.pin_salt);
    assert.ok(row.pin_hash);
    assert.notEqual(row.pin_hash, "2468");
    assert.equal(JSON.stringify(row).includes("2468"), false);
  });

  it("returns 423 before route lookup and unlocks only the cookie-bearing device", async () => {
    const locked = await request("/api/notes/does-not-exist");
    assert.equal(locked.status, 423);
    assert.equal((await locked.json()).error.code, "EBRAINLOCKED");

    const unlocked = await request("/api/notes/config", { cookie: sessionCookie });
    assert.equal(unlocked.status, 200);

    const otherDevice = await request("/api/notes/config");
    assert.equal(otherDevice.status, 423);
  });

  it("requires the same per-device unlock session for WebSocket data", () => {
    assert.equal(isBrainSocketAuthorized({ headers: {} }), false);
    assert.equal(isBrainSocketAuthorized({ headers: { cookie: sessionCookie } }), true);
    assert.equal(
      canReceiveBrainData({ brainRequest: { headers: { cookie: sessionCookie } } }),
      true
    );
  });

  it("denies every protected API surface with one generic non-leaking response", async () => {
    const protectedPaths = [
      "/sessions",
      "/agents",
      "/events",
      "/stats",
      "/analytics",
      "/pricing",
      "/settings/info",
      "/settings/claude-home",
      "/workflows",
      "/push/vapid-public-key",
      "/import/guide",
      "/cc-config/overview",
      "/run",
      "/alerts",
      "/webhooks",
      "/accounts",
      "/schedules",
      "/assistant/ask",
      "/chat/chats",
      "/projects",
      "/notes",
      "/vault/graph",
      "/skills",
      "/github/config",
      "/monday/config",
      "/today",
      "/briefings",
      "/demo",
      "/subscriptions",
      "/business/integrations",
      "/missions",
      "/codex/remote/status",
      "/share-target",
      "/notifications",
    ];

    for (const routePath of protectedPaths) {
      const response = await request(`/api${routePath}`);
      assert.equal(response.status, 423, routePath);
      assert.deepEqual(await response.json(), {
        error: {
          code: "EBRAINLOCKED",
          message: "Brain locked",
          configured: true,
          retryAfterSeconds: 0,
        },
      });
    }
  });

  it("manually locks only the current device", async () => {
    const response = await request("/api/brain-lock/lock", {
      method: "POST",
      cookie: sessionCookie,
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).locked, true);
    assert.equal((await request("/api/notes/config", { cookie: sessionCookie })).status, 423);
    assert.equal(
      canReceiveBrainData({ brainRequest: { headers: { cookie: sessionCookie } } }),
      false
    );
  });

  it("persists a 15-minute lockout after five failures across a server restart", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request("/api/brain-lock/unlock", {
        method: "POST",
        body: JSON.stringify({ pin: "0000" }),
      });
      assert.equal(response.status, attempt === 5 ? 429 : 401);
    }

    await stop();
    await start();

    const blocked = await request("/api/brain-lock/unlock", {
      method: "POST",
      body: JSON.stringify({ pin: "2468" }),
    });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, "EBRAINLOCKOUT");
    assert.ok(body.error.retryAfterSeconds > 0 && body.error.retryAfterSeconds <= 900);
  });

  it("expires inactive sessions and supports only the allowed timeout values", async () => {
    db.prepare(
      "UPDATE brain_lock_config SET locked_until = NULL, failed_attempts = 0 WHERE id = 1"
    ).run();
    const unlocked = await request("/api/brain-lock/unlock", {
      method: "POST",
      body: JSON.stringify({ pin: "2468" }),
    });
    assert.equal(unlocked.status, 200);
    const cookie = unlocked.headers.get("set-cookie");

    const invalid = await request("/api/brain-lock/settings", {
      method: "PUT",
      cookie,
      body: JSON.stringify({ timeoutMinutes: 2 }),
    });
    assert.equal(invalid.status, 400);

    const valid = await request("/api/brain-lock/settings", {
      method: "PUT",
      cookie,
      body: JSON.stringify({ timeoutMinutes: 1 }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {
      configured: true,
      unlocked: true,
      timeoutMinutes: 1,
      lockoutRemainingSeconds: 0,
    });
    db.prepare("UPDATE brain_unlock_sessions SET last_activity_at = ?, expires_at = ?").run(
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:01:00.000Z"
    );
    assert.equal((await request("/api/notes/config", { cookie })).status, 423);
  });

  it("marks cookies Secure for an HTTPS Tailscale host", async () => {
    const response = await request("/api/brain-lock/unlock", {
      method: "POST",
      headers: { host: "jarvis.test.ts.net", "x-forwarded-proto": "https" },
      body: JSON.stringify({ pin: "2468" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure/i);
  });
});
