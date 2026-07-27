/** Codex CLI agent backend (Phase AB2). */

const { randomUUID } = require("node:crypto");
const { createCodexParser } = require("./codex-stream-parser");
const { resolveCodexCommand } = require("../codex-command");

function command() {
  return resolveCodexCommand();
}

function sandboxFor(permissionMode) {
  if (permissionMode === "plan") return "read-only";
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

function buildInvocation({ prompt, mode, model, permissionMode, resumeSessionId, effort }) {
  const sandbox = sandboxFor(permissionMode);
  if (mode === "conversation") {
    return { argv: ["app-server", "--stdio"], protocol: "app-server", sandbox };
  }
  const argv = ["exec", "--json", "--sandbox", sandbox];
  if (model) argv.push("--model", model);
  if (effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (resumeSessionId) argv.push("resume", resumeSessionId);
  argv.push(prompt);
  return { argv, protocol: "exec-json", sandbox };
}

function writeJson(handle, value) {
  if (!handle.child?.stdin?.writable) throw new Error("Codex app-server stdin is not writable");
  handle.child.stdin.write(`${JSON.stringify(value)}\n`);
}

function start(handle) {
  if (handle.providerProtocol !== "app-server") return;
  const state = handle.providerState;
  state.notify = (method, params) => writeJson(handle, { method, params });
  state.request = (method, params, pending) => {
    const id = String(state.nextId++);
    state.pending.set(id, pending || method);
    writeJson(handle, { id, method, params });
    return id;
  };
  state.startTurn = (text) => {
    if (!state.threadId) throw new Error("Codex thread is not ready");
    const messageId = randomUUID();
    state.request(
      "turn/start",
      {
        threadId: state.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: messageId,
      },
      { kind: "turn", messageId }
    );
    return messageId;
  };
  state.request(
    "initialize",
    {
      clientInfo: { name: "jarvis-dashboard", title: "Jarvis Dashboard", version: "1.3.0" },
      capabilities: { experimentalApi: true },
    },
    "initialize"
  );
}

function sendInput(handle, text) {
  const state = handle.providerState;
  if (!state?.threadId) throw new Error("Codex thread is still starting");
  const messageId = randomUUID();
  if (state.activeTurnId) {
    state.request(
      "turn/steer",
      {
        threadId: state.threadId,
        expectedTurnId: state.activeTurnId,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: messageId,
      },
      { kind: "steer", messageId }
    );
  } else {
    state.startTurn(text);
  }
  return { messageId };
}

function createState(sandbox) {
  return {
    nextId: 1,
    pending: new Map(),
    threadId: null,
    activeTurnId: null,
    streamingItems: new Set(),
    sandbox,
  };
}

module.exports = {
  id: "codex",
  label: "Codex",
  get command() {
    return command();
  },
  buildInvocation,
  createParser: createCodexParser,
  createState,
  start,
  sendInput,
  supportsPermissionGate: false,
  supportsConversation: true,
  supportsResume: true,
  steeringMode: "native",
  sandboxFor,
};
