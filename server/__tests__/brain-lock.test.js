const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-brain-lock-"));
process.env.DASHBOARD_DB_PATH = path.join(TEST_DIR, "dashboard.db");
process.env.DASHBOARD_TOKEN = "outer-dashboard-token";
process.env.DASHBOARD_ALLOWED_HOSTS = "jarvis.test.ts.net";
process.env.JARVIS_TEST_BRAIN_LOCK = "1";
process.env.JARVIS_NOTES_DIR = path.join(TEST_DIR, "JarvisNotes");

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const { broadcast } = require("../websocket");

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

async function api(urlPath, options) {
  const response = await request(urlPath, options);
  return { status: response.status, body: await response.json() };
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(base.replace(/^http/, "ws"));
    wsUrl.pathname = "/ws";
    wsUrl.searchParams.set("token", "outer-dashboard-token");
    const ws = new WebSocket(wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
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
  delete process.env.JARVIS_NOTES_DIR;
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

  it("keeps operational APIs available while locked and hides sensitive notes at every notes read boundary", async () => {
    const ordinary = await api("/api/notes", {
      method: "POST",
      cookie: sessionCookie,
      body: JSON.stringify({
        title: "Ordinary",
        body: "ordinary excerpt",
        tags: ["shared-tag"],
        projectId: "selective-project",
      }),
    });
    const secret = await api("/api/notes", {
      method: "POST",
      cookie: sessionCookie,
      body: JSON.stringify({
        title: "Secret",
        body: "classified-needle secret-excerpt",
        tags: ["shared-tag", "secret-tag"],
        projectId: "selective-project",
        sensitive: true,
      }),
    });
    assert.equal(ordinary.status, 201);
    assert.equal(secret.status, 201);
    assert.ok(ordinary.body.note);
    assert.ok(secret.body.note);
    const secretId = secret.body.note.id;
    const secretPath = secret.body.note.path;

    db.prepare("INSERT INTO assistant_captures (id, text, source) VALUES (?, ?, ?)").run(
      "ordinary-capture",
      "ordinary captured thought",
      "test"
    );

    assert.equal((await api("/api/stats")).status, 200);

    for (const urlPath of [
      "/api/notes",
      "/api/notes?q=Secret",
      "/api/notes?q=classified-needle",
      "/api/notes?tag=secret-tag",
      "/api/notes?project=selective-project",
      "/api/notes?includeSensitive=true",
    ]) {
      const result = await api(urlPath);
      assert.equal(result.status, 200, urlPath);
      const serialized = JSON.stringify(result.body);
      for (const secretValue of ["Secret", secretId, secretPath, "secret-excerpt", "secret-tag"]) {
        assert.equal(serialized.includes(secretValue), false, `${urlPath} leaked ${secretValue}`);
      }
    }

    const lockedList = await api("/api/notes");
    assert.ok(lockedList.body.items.some((note) => note.id === ordinary.body.note.id));

    const tags = await api("/api/notes/tags");
    assert.deepEqual(
      tags.body.items.find((item) => item.tag === "shared-tag"),
      {
        tag: "shared-tag",
        count: 1,
      }
    );
    assert.equal(
      tags.body.items.some((item) => item.tag === "secret-tag"),
      false
    );

    const hidden = await api(`/api/notes/${secretId}`);
    const missing = await api("/api/notes/does-not-exist");
    assert.deepEqual(hidden, missing);

    const captures = await api("/api/notes/captures");
    assert.equal(captures.status, 200);
    assert.ok(captures.body.items.some((capture) => capture.id === "ordinary-capture"));
    const serializedCaptures = JSON.stringify(captures.body);
    for (const secretValue of ["Secret", secretId, secretPath, "secret-excerpt", "secret-tag"]) {
      assert.equal(serializedCaptures.includes(secretValue), false);
    }

    const callerEscalatedUpdate = await api(`/api/notes/${secretId}`, {
      method: "PUT",
      body: JSON.stringify({
        title: "Caller leaked rename",
        context: { includeSensitive: true },
      }),
    });
    assert.deepEqual(callerEscalatedUpdate, missing);
    assert.deepEqual(
      await api(`/api/notes/${secretId}`, {
        method: "DELETE",
        body: JSON.stringify({ context: { includeSensitive: true } }),
      }),
      missing
    );

    const hiddenCreation = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        title: "Locked-created secret",
        body: "not echoed",
        sensitive: true,
        context: { includeSensitive: true },
      }),
    });
    assert.equal(hiddenCreation.status, 201);
    assert.equal(hiddenCreation.body.note, null);

    const unlockedList = await api("/api/notes", { cookie: sessionCookie });
    assert.ok(unlockedList.body.items.some((note) => note.id === secretId));
    assert.equal((await api(`/api/notes/${secretId}`, { cookie: sessionCookie })).status, 200);
    assert.equal(
      (await api(`/api/notes/${secretId}`, { cookie: sessionCookie })).body.note.title,
      "Secret"
    );
    assert.ok(
      (await api("/api/notes", { cookie: sessionCookie })).body.items.some(
        (note) => note.title === "Locked-created secret"
      )
    );
    assert.ok(
      (await api("/api/notes?q=classified-needle", { cookie: sessionCookie })).body.items.some(
        (note) => note.id === secretId
      )
    );
    assert.ok(
      (await api("/api/notes?tag=secret-tag", { cookie: sessionCookie })).body.items.some(
        (note) => note.id === secretId
      )
    );
    assert.ok(
      (
        await api("/api/notes?project=selective-project", { cookie: sessionCookie })
      ).body.items.some((note) => note.id === secretId)
    );
    assert.deepEqual(
      (await api("/api/notes/tags", { cookie: sessionCookie })).body.items.find(
        (item) => item.tag === "shared-tag"
      ),
      { tag: "shared-tag", count: 2 }
    );
  });

  it("allows dashboard-token WebSockets while Brain-locked and broadcasts no note metadata", async () => {
    const ws = await openSocket();
    try {
      const received = nextMessage(ws);
      broadcast("note_changed", { count: 1, full: true });
      const message = await received;
      assert.equal(message.type, "note_changed");
      assert.deepEqual(message.data, { count: 1, full: true });
      for (const field of ["id", "title", "path", "excerpt", "tags", "body"]) {
        assert.equal(Object.hasOwn(message.data, field), false);
      }
    } finally {
      ws.close();
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
    assert.equal((await request("/api/notes/config", { cookie: sessionCookie })).status, 200);
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
    assert.equal((await request("/api/brain-lock/status", { cookie })).status, 200);
    assert.equal((await request("/api/notes/config", { cookie })).status, 200);
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
