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
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chat-data-test-"));
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.DASHBOARD_DATA_DIR = TEST_DATA_DIR;
process.env.JARVIS_NOTES_DIR = path.join(TEST_DATA_DIR, "JarvisNotes");
process.env.PROVIDERS_CONFIG_PATH = path.join(
  os.tmpdir(),
  `providers-${Date.now()}-${process.pid}.json`
);

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const notes = require("../lib/notes");
const brainLock = require("../lib/brain-lock");
const providers = require("../lib/providers");

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
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("GET /api/chat/providers", () => {
  it("lists chat providers including the OpenAI-compatible trio (Phase Q1)", async () => {
    const res = await req("/api/chat/providers");
    assert.equal(res.status, 200);
    const ids = res.body.providers.map((p) => p.id);
    assert.ok(ids.includes("gemini"));
    assert.ok(ids.includes("ollama"));
    assert.ok(ids.includes("claude"));
    assert.ok(ids.includes("deepseek"));
    assert.ok(ids.includes("nvidia"));
    // The GPT slot is a real adapter now - honest "not configured" without a key.
    const gpt = res.body.providers.find((p) => p.id === "openai");
    assert.ok(gpt);
    assert.equal(gpt.configured, false);
    assert.match(gpt.note, /OpenAI/i);
    // Vision capability flags drive the attach UI: Gemini yes, DeepSeek no.
    const gemini = res.body.providers.find((p) => p.id === "gemini");
    assert.equal(gemini.capabilities.vision, true);
    const ds = res.body.providers.find((p) => p.id === "deepseek");
    assert.equal(Boolean(ds.capabilities.vision), false);
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

describe("POST /api/assistant/ask sensitive challenge", () => {
  it("trusts only the Brain cookie and returns no sensitive tool or model data while locked", async () => {
    const sensitive = notes.createNote({
      title: "Secret Route Title",
      body: "route-private-renewal-probe",
      sensitive: true,
    });
    const realGetChatProvider = providers.getChatProvider;
    let providerCalls = 0;
    providers.getChatProvider = () => ({
      capabilities: { tools: true },
      isConfigured: () => true,
      async callWithTools(messages) {
        providerCalls += 1;
        if (messages.some((message) => message.role === "tool")) {
          assert.fail(`sensitive tool output reached provider: ${JSON.stringify(messages)}`);
        }
        return {
          text: "",
          toolCalls: [{ name: "vault_search", args: { q: "route-private-renewal-probe" } }],
        };
      },
    });
    try {
      const session = await brainLock.setup("2468", 5);
      const locked = await req("/api/assistant/ask", {
        method: "POST",
        headers: { Origin: BASE },
        body: {
          text: "find the private renewal note",
          source: "chat",
          context: { includeSensitive: true, access: { includeSensitive: true } },
        },
      });
      assert.equal(locked.status, 200);
      assert.deepEqual(locked.body, { pinRequired: true });
      assert.equal(providerCalls, 1);
      assert.doesNotMatch(
        JSON.stringify(locked.body),
        new RegExp(`Secret Route Title|${sensitive.id}|match count`)
      );

      providers.getChatProvider = () => ({
        capabilities: { tools: true },
        isConfigured: () => true,
        async callWithTools(messages) {
          const toolTurn = messages.find((message) => message.role === "tool");
          return toolTurn
            ? { text: "Found the unlocked note.", toolCalls: [] }
            : {
                text: "",
                toolCalls: [{ name: "vault_search", args: { q: "route-private-renewal-probe" } }],
              };
        },
      });
      const unlocked = await req("/api/assistant/ask", {
        method: "POST",
        headers: {
          Origin: BASE,
          Cookie: `${brainLock.COOKIE_NAME}=${session.token}`,
        },
        body: { text: "find the private renewal note", source: "chat" },
      });
      assert.equal(unlocked.status, 200);
      assert.equal(unlocked.body.text, "Found the unlocked note.");
      assert.equal(unlocked.body.pinRequired, undefined);

      const lockedAction = await req("/api/assistant/action", {
        method: "POST",
        headers: { Origin: BASE },
        body: { name: "vault_read", params: { id: sensitive.id } },
      });
      assert.deepEqual(lockedAction.body, { pinRequired: true });

      const unlockedAction = await req("/api/assistant/action", {
        method: "POST",
        headers: {
          Origin: BASE,
          Cookie: `${brainLock.COOKIE_NAME}=${session.token}`,
        },
        body: { name: "vault_read", params: { id: sensitive.id } },
      });
      assert.equal(unlockedAction.body.status, "done");
      assert.equal(unlockedAction.body.result.id, sensitive.id);
    } finally {
      providers.getChatProvider = realGetChatProvider;
      notes.deleteNote(sensitive.id, { includeSensitive: true });
    }
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

// ── Uploads (Phase Q1) ────────────────────────────────────────────────────────

function uploadFile(name, mimeType, content) {
  return new Promise((resolve, reject) => {
    const boundary = "----jarvistest" + Date.now();
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const bodyBuf = Buffer.concat([
      Buffer.from(head),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = new URL("/api/chat/upload", BASE);
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuf.length,
        },
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
    r.write(bodyBuf);
    r.end();
  });
}

describe("POST /api/chat/upload (Phase Q1)", () => {
  it("accepts a text file, serves it back, and threads it into a message", async () => {
    const up = await uploadFile("notes.md", "text/markdown", "# hello attachment");
    assert.equal(up.status, 201);
    const att = up.body.attachment;
    assert.equal(att.kind, "text");
    assert.equal(att.name, "notes.md");
    assert.match(att.file, /^[A-Za-z0-9_-]+\.md$/);

    const served = await req(att.url);
    assert.equal(served.status, 200);

    // Attach it to a message: persisted + echoed as a parsed array.
    const chat = await req("/api/chat/chats", { method: "POST", body: {} });
    const msgRes = await req(`/api/chat/chats/${chat.body.chat.id}/messages`, {
      method: "POST",
      body: { text: "see attached", provider: "nope-provider", attachments: [att] },
    });
    // Unknown provider still 400s - but only AFTER attachment sanitizing works;
    // use gemini (never configured in tests) via the transcript instead:
    assert.equal(msgRes.status, 400);
    const withProvider = await req(`/api/chat/chats/${chat.body.chat.id}/messages`, {
      method: "POST",
      body: { text: "see attached", provider: "gemini", attachments: [att] },
    });
    // SSE response: the stream errors (no key) but the user turn persisted.
    void withProvider;
    const full = await req(`/api/chat/chats/${chat.body.chat.id}`);
    const userMsg = full.body.messages.find(
      (m) => m.role === "user" && m.content === "see attached"
    );
    assert.ok(userMsg);
    assert.equal(userMsg.attachments.length, 1);
    assert.equal(userMsg.attachments[0].file, att.file);
  });

  it("rejects a disallowed type and a crafted attachment path", async () => {
    const up = await uploadFile("app.exe", "application/x-msdownload", Buffer.from([1, 2, 3]));
    assert.equal(up.status, 400);
    assert.equal(up.body.error.code, "EBADTYPE");

    const chat = await req("/api/chat/chats", { method: "POST", body: {} });
    await req(`/api/chat/chats/${chat.body.chat.id}/messages`, {
      method: "POST",
      body: {
        text: "sneaky",
        provider: "gemini",
        attachments: [{ file: "../../etc/passwd", name: "x", kind: "text" }],
      },
    });
    const full = await req(`/api/chat/chats/${chat.body.chat.id}`);
    const userMsg = full.body.messages.find((m) => m.content === "sneaky");
    assert.ok(userMsg);
    assert.equal(userMsg.attachments.length, 0); // dropped by the sanitizer
  });
});

describe("SSE user echo", () => {
  it("includes created_at (a missing one crashed MessageBubble → black screen)", async () => {
    const chat = await req("/api/chat/chats", { method: "POST", body: {} });
    const res = await req(`/api/chat/chats/${chat.body.chat.id}/messages`, {
      method: "POST",
      body: { text: "hello", provider: "gemini" },
    });
    // Body is raw SSE text; the stream errors (no key) but the user echo comes first.
    const userLine = String(res.body)
      .split("\n\n")
      .find((e) => e.startsWith("event: user"));
    assert.ok(userLine, "expected an `event: user` SSE frame");
    const msg = JSON.parse(userLine.split("\ndata: ")[1]);
    assert.ok(msg.created_at, "user echo must carry created_at");
  });
});

// ── Link preview SSRF guard (Phase Q2) ───────────────────────────────────────

describe("link-preview SSRF guard", () => {
  const { __isPrivateIp, __assertSafeUrl } = require("../lib/link-preview");

  it("classifies private/public addresses correctly", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:192.168.1.1",
    ]) {
      assert.equal(__isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      assert.equal(__isPrivateIp(ip), false, ip);
    }
  });

  it("rejects non-http schemes, IP literals in private ranges, and localhost", async () => {
    await assert.rejects(() => __assertSafeUrl("file:///etc/passwd"));
    await assert.rejects(() => __assertSafeUrl("ftp://example.com/x"));
    await assert.rejects(() => __assertSafeUrl("http://127.0.0.1:3000/api"));
    await assert.rejects(() => __assertSafeUrl("http://192.168.1.10/admin"));
    await assert.rejects(() => __assertSafeUrl("http://localhost:1188/"));
    await assert.rejects(() => __assertSafeUrl("http://foo.local/"));
    await assert.rejects(() => __assertSafeUrl("not a url"));
  });

  it("the route surfaces a clean 502 for a blocked URL", async () => {
    const res = await req(`/api/chat/link-preview?url=${encodeURIComponent("http://127.0.0.1/")}`);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "EPREVIEW");
  });
});
