/**
 * @file providers/agent/gemini-cli.js
 * @description Gemini CLI agentic backend (Phase E, §E2). The user's Gemini Pro
 * plan raises the CLI's limits, making `gemini` a viable second agentic backend
 * alongside Claude. run-spawner spawns this exactly like the Claude path - same
 * child-process supervision, same envelope buffer, same WS broadcasts - but the
 * argv and the stdout parser come from here, and the PreToolUse permission gate
 * does NOT apply (it's Claude-only; the UI must not imply otherwise).
 *
 * SCOPE / HONESTY: v1 is headless (single-shot) only - no multi-turn stdin
 * conversation, no `--resume`, no interactive permission gate. The exact CLI
 * flags and stream schema below are a best-effort mapping that MUST be verified
 * against the installed `gemini` version (none was available to probe at build
 * time; see the Phase E status note in the plan). `GEMINI_CLI_COMMAND` and
 * `GEMINI_CLI_ARGS` env overrides let the user correct the invocation without a
 * code change.
 *
 * @author Jarvis (Phase E)
 */

const { createGeminiParser } = require("./gemini-stream-parser");

function command() {
  return process.env.GEMINI_CLI_COMMAND || "gemini";
}

/**
 * Build argv for a headless Gemini agentic run. Extra/override flags can be
 * supplied via GEMINI_CLI_ARGS (space-split) for host-specific tuning.
 */
function buildArgv({ prompt, model }) {
  const argv = ["--output-format", "stream-json"];
  const extra = process.env.GEMINI_CLI_ARGS;
  if (extra) {
    for (const a of extra.split(/\s+/).filter(Boolean)) argv.push(a);
  }
  if (model) argv.push("--model", model);
  // Prompt last so it's unambiguous.
  argv.push("-p", prompt);
  return argv;
}

module.exports = {
  id: "gemini-cli",
  label: "Gemini CLI",
  get command() {
    return command();
  },
  buildArgv,
  createParser: createGeminiParser,
  supportsPermissionGate: false, // no dashboard gate for Gemini runs
  supportsConversation: false, // headless only in v1
  supportsResume: false,
};
