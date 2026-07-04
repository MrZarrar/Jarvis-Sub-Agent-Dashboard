/**
 * @file providers/agent/index.js
 * @description Registry of agentic (tool-using, spawnable) backends for the Run
 * feature (Phase E, §E2). run-spawner selects a backend by `provider`; "claude"
 * is the default and keeps its historical behavior byte-for-byte.
 *
 * @author Jarvis (Phase E)
 */

const claude = require("./claude");
const geminiCli = require("./gemini-cli");

const AGENT_PROVIDERS = { claude, "gemini-cli": geminiCli };
const DEFAULT_AGENT_PROVIDER = "claude";

function getAgentProvider(name) {
  return AGENT_PROVIDERS[name] || null;
}

/** Ids the spawn route accepts, for validation + the UI picker. */
function listAgentProviderIds() {
  return Object.keys(AGENT_PROVIDERS);
}

/** Lightweight descriptors for the client (no functions). */
function listAgentProviders() {
  return Object.values(AGENT_PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    supportsPermissionGate: Boolean(p.supportsPermissionGate),
    supportsConversation: Boolean(p.supportsConversation),
    supportsResume: Boolean(p.supportsResume),
  }));
}

module.exports = {
  AGENT_PROVIDERS,
  DEFAULT_AGENT_PROVIDER,
  getAgentProvider,
  listAgentProviderIds,
  listAgentProviders,
};
