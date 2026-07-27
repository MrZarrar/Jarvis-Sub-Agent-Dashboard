const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const { CodexAppServer } = require("../lib/codex-app-server");

function fakeProcess(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0, "SIGTERM");
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line), child);
    }
  });
  return child;
}

describe("Codex app-server supervisor", () => {
  it("initializes once, strips API credentials, and multiplexes requests", async () => {
    let spawnCount = 0;
    let spawnedEnv;
    const server = new CodexAppServer({
      commandResolver: () => "/fake/codex",
      spawnImpl(_command, _args, options) {
        spawnCount += 1;
        spawnedEnv = options.env;
        return fakeProcess((message, child) => {
          if (message.method === "initialize") {
            child.stdout.write(
              `${JSON.stringify({ id: message.id, result: { platformFamily: "unix" } })}\n`
            );
          } else if (message.id) {
            child.stdout.write(
              `${JSON.stringify({ id: message.id, result: { ok: message.method } })}\n`
            );
          }
        });
      },
    });
    const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"];
    const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = "must-not-leak";
    try {
      await Promise.all([server.start(), server.start()]);
      assert.equal(spawnCount, 1);
      assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
      assert.equal(spawnedEnv.OPENAI_BASE_URL, undefined);
      assert.equal(spawnedEnv.CODEX_API_KEY, undefined);
      assert.deepEqual(await server.request("thread/list", {}), { ok: "thread/list" });
      assert.deepEqual(await server.request("thread/goal/set", { threadId: "t1" }), {
        ok: "thread/goal/set",
      });
    } finally {
      for (const name of names) {
        if (old[name] == null) delete process.env[name];
        else process.env[name] = old[name];
      }
      server.stop();
    }
  });

  it("reads and caches native subscription rate limits", async () => {
    let rateLimitRequests = 0;
    const server = new CodexAppServer({
      commandResolver: () => "/fake/codex",
      spawnImpl() {
        return fakeProcess((message, proc) => {
          if (message.method === "initialize") {
            proc.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          } else if (message.method === "account/rateLimits/read") {
            rateLimitRequests += 1;
            assert.equal(message.params, null);
            proc.stdout.write(
              `${JSON.stringify({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25 } } } })}\n`
            );
          }
        });
      },
    });
    try {
      const first = await server.getRateLimits();
      const second = await server.getRateLimits();
      assert.equal(first.rateLimits.primary.usedPercent, 25);
      assert.equal(second, first);
      assert.equal(rateLimitRequests, 1);
    } finally {
      server.stop();
    }
  });

  it("surfaces server-initiated approvals without treating them as responses", async () => {
    let child;
    const server = new CodexAppServer({
      commandResolver: () => "/fake/codex",
      spawnImpl() {
        child = fakeProcess((message, proc) => {
          if (message.method === "initialize") {
            proc.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          }
        });
        return child;
      },
    });
    await server.start();
    const request = once(server, "serverRequest");
    child.stdout.write(
      `${JSON.stringify({
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t1", turnId: "u1", itemId: "i1", startedAtMs: 1 },
      })}\n`
    );
    const [message] = await request;
    assert.equal(message.id, 99);
    server.stop();
  });

  it("rejects outbound methods outside the pinned protocol", async () => {
    const server = new CodexAppServer({ commandResolver: () => "/fake/codex" });
    await assert.rejects(
      server._requestWithoutStart("jarvis/invented", {}),
      /does not match pinned Codex/
    );
  });

  it("rejects unknown inbound server methods", async () => {
    let child;
    const server = new CodexAppServer({
      commandResolver: () => "/fake/codex",
      spawnImpl() {
        child = fakeProcess((message, proc) => {
          if (message.method === "initialize") {
            proc.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          }
        });
        return child;
      },
    });
    await server.start();
    const rejected = once(server, "protocolError");
    child.stdout.write(`${JSON.stringify({ id: 7, method: "jarvis/invented", params: {} })}\n`);
    const [problem] = await rejected;
    assert.match(problem.error.message, /Unsupported Codex server request/);
    server.stop();
  });

  it("accepts null JSON-RPC results and can restart after a clean stop", async () => {
    let spawnCount = 0;
    const server = new CodexAppServer({
      commandResolver: () => "/fake/codex",
      spawnImpl() {
        spawnCount += 1;
        return fakeProcess((message, proc) => {
          proc.stdout.write(
            `${JSON.stringify({ id: message.id, result: message.method === "thread/list" ? null : {} })}\n`
          );
        });
      },
    });
    await server.start();
    assert.equal(await server.request("thread/list", {}), null);
    server.stop();
    await server.start();
    assert.equal(spawnCount, 2);
    server.stop();
  });
});
