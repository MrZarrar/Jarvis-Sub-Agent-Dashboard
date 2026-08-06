/**
 * @file providers/codex.js
 * @description Subscription-backed GPT chat through the local Codex CLI.
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const { getProviderConfig } = require("./config");
const { resolveCodexCommand } = require("./codex-command");
const { callWithToolsViaChat } = require("./cli-tools");

const MAX_STDERR = 2_000;
const SUBSCRIPTION_DEFAULT_MODEL = "gpt-5.6-luna";
let spawnImpl = spawn;

function command() {
  return resolveCodexCommand();
}

function cfg() {
  return getProviderConfig("codex");
}

function isConfigured() {
  return Boolean(cfg().enabled);
}

function listModels() {
  return [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fast)" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (deep)" },
  ];
}

function conversationPrompt(messages) {
  const parts = [
    "<mini_jarvis_mode>",
    "Act only as Mini Jarvis's conversational language model.",
    "Answer solely from the conversation supplied below.",
    "Do not use Codex's own shell, file, browser, MCP, or computer tools.",
    "When a Jarvis action protocol is supplied, request actions only through that protocol; Jarvis's gated dispatcher executes them.",
    "</mini_jarvis_mode>",
  ];
  for (const message of messages || []) {
    if (!message || typeof message.content !== "string") continue;
    const role =
      message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
    parts.push(`${role}: ${message.content}`);
  }
  return parts.join("\n\n");
}

function agentText(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "item.completed") return null;
  const item = obj.item;
  if (!item || !["agent_message", "agentMessage"].includes(item.type)) return null;
  return typeof item.text === "string" && item.text ? item.text : null;
}

async function* chatStream(messages, opts = {}) {
  const argv = [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    os.tmpdir(),
    "-",
  ];
  const configuredModel = cfg().defaultModel;
  const requestedModel =
    opts.model ||
    (configuredModel && configuredModel !== "default"
      ? configuredModel
      : SUBSCRIPTION_DEFAULT_MODEL);
  if (requestedModel && requestedModel !== "default") argv.splice(1, 0, "--model", requestedModel);

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  const child = spawnImpl(command(), argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  const queue = [];
  let resolveNext = null;
  let done = false;
  let failure = null;
  let stderr = "";
  let buffer = "";

  const emit = (item) => {
    if (resolveNext) {
      resolveNext(item);
      resolveNext = null;
    } else {
      queue.push(item);
    }
  };
  const consume = (line) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      const text = agentText(obj);
      if (text) emit({ text });
      if (obj.type === "turn.failed" || obj.type === "error") {
        failure = new Error(obj.message || obj.error?.message || "Codex turn failed");
      }
    } catch {
      // Codex stdout is JSONL; an isolated malformed diagnostic is non-fatal.
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
  });
  child.on("error", (err) => {
    failure = new Error(`codex spawn failed: ${err.message}`);
    done = true;
    emit(null);
  });
  child.on("exit", (code) => {
    if (buffer) consume(buffer);
    if (code !== 0 && !failure) {
      failure = new Error(`codex exited ${code}: ${stderr.slice(-300) || "no output"}`);
    }
    done = true;
    emit(null);
  });

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  }
  child.stdin.end(conversationPrompt(messages));

  try {
    while (true) {
      const item = queue.length
        ? queue.shift()
        : await new Promise((resolve) => (resolveNext = resolve));
      if (item === null) break;
      yield item;
    }
    if (failure) throw failure;
  } finally {
    if (!done) child.kill("SIGTERM");
  }
}

function callWithTools(messages, tools = [], opts = {}) {
  return callWithToolsViaChat(chatStream, messages, tools, opts);
}

module.exports = {
  id: "codex",
  label: "GPT (Codex)",
  note: "uses the local Codex CLI and your ChatGPT subscription - no API key",
  capabilities: { chat: true, image: false, vision: false, tools: true, promptTools: true },
  isConfigured,
  listModels,
  chatStream,
  callWithTools,
  conversationPrompt,
  agentText,
  __setSpawnForTest(fn) {
    spawnImpl = fn || spawn;
  },
};
