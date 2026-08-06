/** Safe provider availability, billing, model, and control diagnostics. */

const { spawnSync } = require("node:child_process");
const config = require("./providers/config");
const { codexAppServer } = require("./codex-app-server");
const { all: featureFlags } = require("./features");
const { profileDiagnostics } = require("./environment-profile");

function commandFound(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

function disabled(provider) {
  return ["1", "true", "on"].includes(
    String(
      process.env[`JARVIS_PROVIDER_${provider.toUpperCase().replaceAll("-", "_")}_DISABLED`] || ""
    ).toLowerCase()
  );
}

async function capabilities() {
  const cfg = config.getConfig();
  const codex = disabled("codex")
    ? {
        ready: false,
        authenticated: false,
        accessType: "unavailable",
        models: [],
        lastError: "disabled by kill switch",
      }
    : await codexAppServer.diagnostics();
  const claudePath = commandFound("claude");
  return {
    environment: profileDiagnostics(),
    features: featureFlags(),
    providers: [
      {
        id: "codex",
        label: "Codex",
        available: Boolean(codex.ready && codex.authType === "chatgpt"),
        accessType: codex.authType === "chatgpt" ? "subscription_cli" : "unavailable",
        billingLabel: "ChatGPT subscription CLI",
        path: commandFound("codex"),
        version: codex.version || null,
        models: (codex.models || []).map((model) => ({
          id: model.id || model.model,
          name: model.displayName || model.model || model.id,
          default: Boolean(model.isDefault),
          reasoning: model.supportedReasoningEfforts || [],
        })),
        controls: ["start", "resume", "fork", "steer", "interrupt", "approve", "archive"],
        error: codex.lastError || null,
      },
      {
        id: "claude-code",
        label: "Claude Code",
        available: Boolean(claudePath && !disabled("claude-code")),
        accessType: "subscription_cli",
        billingLabel: "Claude subscription CLI",
        path: claudePath,
        models: (cfg.claude?.chatModels || []).map((id) => ({ id, name: id })),
        controls: ["start", "steer", "interrupt", "approve"],
      },
    ],
    policy: {
      genericConversation: "codex",
      genericBoundedAction: "codex",
      personal: "codex",
      business: "codex",
      developmentOwner: "codex",
      developmentWorker: "claude-code",
      silentFallback: false,
    },
  };
}

module.exports = { capabilities, commandFound };
