/** Phase AB2: Codex exec JSONL normalization and native app-server steering. */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");

process.env.DASHBOARD_DB_PATH = path.join(os.tmpdir(), `codex-agent-${process.pid}.db`);

const codex = require("../lib/providers/agent/codex");
const { normalizeExec, normalizeItem } = require("../lib/providers/agent/codex-stream-parser");
const runs = require("../lib/run-spawner");
const dashboardRuns = require("../lib/dashboard-runs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = function (signal) {
    this.killed = true;
    setImmediate(() => this.emit("exit", signal === "SIGTERM" ? 143 : 0, signal));
  };
  return child;
}

function lines(chunks) {
  return chunks.join("").trim().split("\n").filter(Boolean).map(JSON.parse);
}

describe("Codex agent provider", () => {
  beforeEach(() => runs.__reset());

  it("builds exec --json with an explicit sandbox", () => {
    const invocation = codex.buildInvocation({
      prompt: "inspect",
      mode: "headless",
      permissionMode: "plan",
    });
    assert.deepEqual(invocation.argv.slice(0, 4), ["exec", "--json", "--sandbox", "read-only"]);
    assert.equal(invocation.argv.at(-1), "inspect");
  });

  it("uses app-server for conversations and advertises native steering", () => {
    const invocation = codex.buildInvocation({ prompt: "hi", mode: "conversation" });
    assert.deepEqual(invocation.argv, ["app-server", "--stdio"]);
    assert.equal(invocation.protocol, "app-server");
    assert.equal(codex.steeringMode, "native");
  });

  it("persists the provider so Codex history resumes as Codex", () => {
    const id = randomUUID();
    dashboardRuns.recordRun({
      id,
      provider: "codex",
      cwd: "/tmp",
      mode: "conversation",
      status: "completed",
      prompt: "persist provider",
    });
    assert.equal(dashboardRuns.getRun(id).provider, "codex");
  });

  it("normalizes Codex exec thread, assistant, tool, and result events", () => {
    assert.equal(normalizeExec({ type: "thread.started", thread_id: "t1" })[0].session_id, "t1");
    assert.equal(
      normalizeItem({ type: "agent_message", id: "m1", text: "done" })[0].message.content[0].text,
      "done"
    );
    const tool = normalizeItem({
      type: "commandExecution",
      id: "c1",
      command: "npm test",
      aggregatedOutput: "ok",
      status: "completed",
    });
    assert.equal(tool[0].message.content[0].name, "Bash");
    assert.equal(tool[1].message.content[0].content, "ok");
    assert.equal(
      normalizeExec({ type: "turn.completed", usage: { output_tokens: 3 } })[0].type,
      "result"
    );
  });

  it("initializes a thread then sends turn/steer while a turn is active", async () => {
    const child = fakeChild();
    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(chunk.toString()));
    const state = codex.createState("workspace-write");
    const handle = runs.__injectChildForTest({
      child,
      provider: "codex",
      providerProtocol: "app-server",
      providerState: state,
      createParser: codex.createParser,
      steeringMode: "native",
      prompt: "first turn",
    });
    codex.start(handle);
    await new Promise((resolve) => setImmediate(resolve));
    let sent = lines(chunks);
    assert.equal(sent[0].method, "initialize");

    child.stdout.write(`${JSON.stringify({ id: sent[0].id, result: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    sent = lines(chunks);
    const threadStart = sent.find((m) => m.method === "thread/start");
    assert.ok(threadStart);
    assert.equal(threadStart.params.approvalPolicy, "never");

    child.stdout.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: "thread-1234" } } })}\n`
    );
    await new Promise((resolve) => setImmediate(resolve));
    sent = lines(chunks);
    assert.ok(sent.find((m) => m.method === "turn/start"));
    assert.equal(runs.getRun(handle.id).sessionId, "thread-1234");

    child.stdout.write(
      `${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1234", turn: { id: "turn-1" } } })}\n`
    );
    await new Promise((resolve) => setImmediate(resolve));
    runs.sendInput(handle.id, "change direction");
    await new Promise((resolve) => setImmediate(resolve));
    sent = lines(chunks);
    const steer = sent.find((m) => m.method === "turn/steer");
    assert.ok(steer);
    assert.equal(steer.params.expectedTurnId, "turn-1");
    assert.equal(steer.params.input[0].text, "change direction");
  });
});
