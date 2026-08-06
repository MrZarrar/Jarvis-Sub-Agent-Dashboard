/** Subscription-backed Mini Jarvis chat through the local Codex CLI. */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const codex = require("../lib/providers/codex");
const { resolveCodexCommand } = require("../lib/providers/codex-command");

function fakeChild(onPrompt) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 143);
  let prompt = "";
  child.stdin.on("data", (chunk) => (prompt += chunk.toString("utf8")));
  child.stdin.on("finish", () => {
    onPrompt(prompt);
    setImmediate(() => {
      child.stdout.write(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "At your service." } })}\n`
      );
      child.stdout.end();
      child.emit("exit", 0);
    });
  });
  return child;
}

describe("Codex subscription chat provider", () => {
  afterEach(() => codex.__setSpawnForTest(null));

  it("uses ephemeral read-only Codex auth and streams the final GPT answer", async () => {
    let invocation;
    let suppliedPrompt;
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-reach-codex";
    codex.__setSpawnForTest((command, argv, options) => {
      invocation = { command, argv, options };
      return fakeChild((prompt) => (suppliedPrompt = prompt));
    });

    const chunks = [];
    try {
      for await (const chunk of codex.chatStream([
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ])) {
        chunks.push(chunk.text);
      }
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }

    assert.match(invocation.command, /codex(?:\.exe)?$/);
    assert.ok(invocation.argv.includes("--ephemeral"));
    assert.ok(invocation.argv.includes("--ignore-user-config"));
    assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(invocation.argv[invocation.argv.indexOf("--sandbox") + 1], "read-only");
    assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
    assert.match(suppliedPrompt, /Do not use Codex's own shell, file, browser, MCP/);
    assert.match(suppliedPrompt, /User: Hello/);
    assert.equal(chunks.join(""), "At your service.");
  });

  it("exposes Jarvis actions through the shared structured protocol", async () => {
    let suppliedPrompt;
    codex.__setSpawnForTest(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit("exit", 143);
      let prompt = "";
      child.stdin.on("data", (chunk) => (prompt += chunk.toString("utf8")));
      child.stdin.on("finish", () => {
        suppliedPrompt = prompt;
        setImmediate(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  text: "Opening it.",
                  toolCalls: [{ name: "open_browser", args: { url: "https://github.com" } }],
                }),
              },
            })}\n`
          );
          child.stdout.end();
          child.emit("exit", 0);
        });
      });
      return child;
    });

    const out = await codex.callWithTools(
      [{ role: "user", content: "Open GitHub" }],
      [{ name: "open_browser", parameters: { type: "object", properties: {} } }]
    );
    assert.equal(out.text, "Opening it.");
    assert.deepEqual(out.toolCalls, [
      { name: "open_browser", args: { url: "https://github.com" } },
    ]);
    assert.match(suppliedPrompt, /Available actions:/);
    assert.match(suppliedPrompt, /open_browser/);
  });

  it("normalizes both Codex agent-message spellings", () => {
    assert.equal(
      codex.agentText({ type: "item.completed", item: { type: "agent_message", text: "one" } }),
      "one"
    );
    assert.equal(
      codex.agentText({ type: "item.completed", item: { type: "agentMessage", text: "two" } }),
      "two"
    );
  });

  it("discovers Codex inside the VS Code extension when PATH cannot", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discovery-"));
    const binary = process.platform === "win32" ? "codex.exe" : "codex";
    const installed = path.join(
      home,
      ".vscode",
      "extensions",
      "openai.chatgpt-99.0.0-test",
      "bin",
      "macos-aarch64",
      binary
    );
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "test");
    fs.chmodSync(installed, 0o755);
    try {
      assert.equal(resolveCodexCommand({ env: {}, home, lookup: () => null }), installed);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("honors an explicit CODEX_CLI_COMMAND override", () => {
    assert.equal(
      resolveCodexCommand({ env: { CODEX_CLI_COMMAND: "/custom/codex" }, lookup: () => null }),
      "/custom/codex"
    );
  });
});
