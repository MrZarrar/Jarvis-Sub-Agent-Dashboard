/**
 * @file providers.test.js
 * @description Unit tests for the Phase E multi-provider harness: the provider
 * config store (defaults, env fallback, redaction, persistence), the agentic
 * backend registry (claude default + gemini-cli capabilities/argv), and the
 * gemini-cli → dashboard-envelope stream normalizer.
 * @author Jarvis (Phase E)
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function freshConfig(env = {}) {
  delete require.cache[require.resolve("../lib/providers/config")];
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = require("../lib/providers/config");
  return { mod, restore: () => Object.assign(process.env, saved) };
}

describe("providers/config", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns built-in defaults when no file and no env exist", () => {
    const { mod, restore } = freshConfig({
      PROVIDERS_CONFIG_PATH: path.join(tmp, "p.json"),
      GEMINI_API_KEY: undefined,
      OLLAMA_HOST: undefined,
    });
    try {
      const cfg = mod.getConfig();
      assert.equal(cfg.gemini.apiKey, "");
      assert.equal(cfg.ollama.host, "http://localhost:11434");
      assert.equal(cfg.claude.enabled, true);
      assert.equal(cfg.openai.enabled, false);
    } finally {
      restore();
    }
  });

  it("fills empty secrets from env, but a file value wins", () => {
    const file = path.join(tmp, "p.json");
    const { mod, restore } = freshConfig({
      PROVIDERS_CONFIG_PATH: file,
      GEMINI_API_KEY: "env-key",
      OLLAMA_HOST: "http://work-pc:11434",
    });
    try {
      assert.equal(mod.getConfig().gemini.apiKey, "env-key");
      assert.equal(mod.getConfig().ollama.host, "http://work-pc:11434");
      mod.updateConfig({ gemini: { apiKey: "file-key" } });
      assert.equal(mod.getConfig().gemini.apiKey, "file-key"); // file overrides env
    } finally {
      restore();
    }
  });

  it("persists updates atomically and only whitelisted fields", () => {
    const file = path.join(tmp, "p.json");
    const { mod, restore } = freshConfig({ PROVIDERS_CONFIG_PATH: file });
    try {
      mod.updateConfig({
        gemini: { defaultModel: "gemini-2.5-pro", bogusField: "x" },
        ollama: { host: "http://h:11434" },
      });
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(onDisk.gemini.defaultModel, "gemini-2.5-pro");
      assert.equal(onDisk.gemini.bogusField, undefined); // not whitelisted
      assert.equal(onDisk.ollama.host, "http://h:11434");
    } finally {
      restore();
    }
  });

  it("redacted view never leaks the secret", () => {
    const { mod, restore } = freshConfig({
      PROVIDERS_CONFIG_PATH: path.join(tmp, "p.json"),
      GEMINI_API_KEY: "super-secret",
    });
    try {
      const red = mod.redactedConfig();
      assert.equal(red.gemini.hasApiKey, true);
      assert.equal("apiKey" in red.gemini, false);
      assert.equal(JSON.stringify(red).includes("super-secret"), false);
    } finally {
      restore();
    }
  });
});

describe("providers/agent registry", () => {
  const agent = require("../lib/providers/agent");

  it("defaults to claude and exposes it byte-identically (own argv/parser in run-spawner)", () => {
    assert.equal(agent.DEFAULT_AGENT_PROVIDER, "claude");
    const claude = agent.getAgentProvider("claude");
    assert.equal(claude.command, "claude");
    assert.equal(claude.supportsPermissionGate, true);
    assert.equal(claude.supportsConversation, true);
  });

  it("gemini-cli is headless with no permission gate and builds a -p argv", () => {
    const g = agent.getAgentProvider("gemini-cli");
    assert.equal(g.supportsPermissionGate, false);
    assert.equal(g.supportsConversation, false);
    const argv = g.buildArgv({ prompt: "hello", model: "gemini-2.5-pro" });
    assert.ok(argv.includes("-p"));
    assert.equal(argv[argv.indexOf("-p") + 1], "hello");
    assert.ok(argv.includes("--model"));
    assert.equal(argv[argv.indexOf("--model") + 1], "gemini-2.5-pro");
  });

  it("returns null for an unknown provider", () => {
    assert.equal(agent.getAgentProvider("nope"), null);
    assert.deepEqual(agent.listAgentProviderIds().sort(), ["claude", "gemini-cli"]);
  });
});

describe("gemini-cli stream normalizer", () => {
  const { normalize, createGeminiParser } = require("../lib/providers/agent/gemini-stream-parser");

  it("maps a text event to an assistant text envelope", () => {
    const out = normalize({ type: "content", text: "hi there" });
    const assistant = out.find((e) => e.type === "assistant");
    assert.ok(assistant);
    assert.equal(assistant.message.content[0].type, "text");
    assert.equal(assistant.message.content[0].text, "hi there");
  });

  it("maps a tool call to a tool_use envelope", () => {
    const out = normalize({ type: "tool_call", name: "Bash", id: "c1", input: { cmd: "ls" } });
    const a = out.find((e) => e.type === "assistant");
    assert.equal(a.message.content[0].type, "tool_use");
    assert.equal(a.message.content[0].name, "Bash");
    assert.equal(a.message.content[0].id, "c1");
  });

  it("passes through an already-shaped dashboard envelope untouched", () => {
    const env = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    };
    assert.deepEqual(normalize(env), [env]);
  });

  it("keeps an unrecognized line visible as an inert system/gemini_raw envelope", () => {
    const out = normalize({ weird: "shape" });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "system");
    assert.equal(out[0].subtype, "gemini_raw");
  });

  it("createGeminiParser feeds normalized envelopes through the line parser", () => {
    const seen = [];
    const parser = createGeminiParser(
      (env) => seen.push(env),
      () => {}
    );
    parser.push('{"type":"content","text":"a"}\n');
    parser.push('{"type":"tool_call","name":"Read","id":"t1"}\n');
    parser.flush();
    assert.equal(seen.filter((e) => e.type === "assistant").length, 2);
  });

  it("never throws on malformed / empty objects", () => {
    assert.deepEqual(normalize(null), []);
    assert.deepEqual(normalize(undefined), []);
    assert.doesNotThrow(() => normalize({}));
  });
});
