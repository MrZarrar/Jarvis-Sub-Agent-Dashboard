/**
 * @file providers/agent/claude.js
 * @description Claude agentic backend descriptor (Phase E, §E2). This is the
 * DEFAULT backend and the one run-spawner has always used; wrapping it behind an
 * adapter is purely so a second backend (gemini-cli) can slot in beside it. To
 * guarantee the Claude path stays byte-identical (proven by the existing
 * run.test.js), run-spawner keeps its own `buildArgv` and `createLineParser` for
 * this provider — this descriptor only declares the command + capabilities.
 *
 * @author Jarvis (Phase E)
 */

const { createLineParser } = require("../../stream-json-parser");

module.exports = {
  id: "claude",
  label: "Claude",
  command: "claude",
  // Claude's stream-json envelopes ARE the dashboard's envelope vocabulary, so
  // the raw line parser passes them straight through.
  createParser: createLineParser,
  supportsPermissionGate: true, // the PreToolUse gate is Claude-only
  supportsConversation: true,
  supportsResume: true,
};
