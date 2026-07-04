/**
 * @file chat.test.js
 * @description Integration tests for the Phase E chat routes: provider listing
 * (incl. the inert GPT slot), redacted config (no secret leak), chat CRUD, and
 * message-endpoint validation. Streaming completions need a live provider, so
 * those are exercised only for their input-validation errors here.
 * @author Jarvis (Phase E)
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TEST_DB = path.join(os.tmpdir(), `chat-test-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.PROVIDERS_CONFIG_PATH = path.join(
  os.tmpdir(),
  `providers-${Date.now()}-${process.pid}.json`
);

const { createApp, startServer } = require("../index");
const { db } = require("../db");

let server;
let BASE;

function req(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (options.body) r.write(JSON.stringify(options.body));
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
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TEST_DB + suffix);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(process.env.PROVIDERS_CONFIG_PATH);
  } catch {
    /* ignore */
  }
});

describe("GET /api/chat/providers", () => {
  it("lists chat providers including the inert GPT slot", async () => {
    const res = await req("/api/chat/providers");
    assert.equal(res.status, 200);
    const ids = res.body.providers.map((p) => p.id);
    assert.ok(ids.includes("gemini"));
    assert.ok(ids.includes("ollama"));
    assert.ok(ids.includes("claude"));
    const gpt = res.body.providers.find((p) => p.id === "openai");
    assert.ok(gpt);
    assert.equal(gpt.disabled, true);
    assert.match(gpt.note, /OpenAI/i);
  });
});

describe("GET /api/chat/config", () => {
  it("returns a redacted config with no raw secret fields", async () => {
    const res = await req("/api/chat/config");
    assert.equal(res.status, 200);
    assert.equal("apiKey" in res.body.config.gemini, false);
    assert.equal("hasApiKey" in res.body.config.gemini, true);
    assert.equal(typeof res.body.config.ollama.host, "string");
  });
});

describe("chat CRUD", () => {
  let chatId;

  it("creates a chat", async () => {
    const res = await req("/api/chat/chats", {
      method: "POST",
      body: { title: "test chat", provider: "gemini", model: "gemini-2.5-flash" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.chat.title, "test chat");
    chatId = res.body.chat.id;
  });

  it("lists the chat", async () => {
    const res = await req("/api/chat/chats");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.some((c) => c.id === chatId));
  });

  it("fetches the chat with an empty message list", async () => {
    const res = await req(`/api/chat/chats/${chatId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, []);
  });

  it("rejects a message with an unknown provider (400 before any streaming)", async () => {
    const res = await req(`/api/chat/chats/${chatId}/messages`, {
      method: "POST",
      body: { text: "hi", provider: "does-not-exist" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "EBADPROVIDER");
  });

  it("rejects an empty message", async () => {
    const res = await req(`/api/chat/chats/${chatId}/messages`, {
      method: "POST",
      body: { text: "   ", provider: "gemini" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "EBADINPUT");
  });

  it("404s an unknown chat", async () => {
    const res = await req("/api/chat/chats/nope-nope");
    assert.equal(res.status, 404);
  });

  it("deletes the chat", async () => {
    const res = await req(`/api/chat/chats/${chatId}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const after = await req(`/api/chat/chats/${chatId}`);
    assert.equal(after.status, 404);
  });
});
