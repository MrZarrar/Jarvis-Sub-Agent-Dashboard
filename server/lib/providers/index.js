/**
 * @file providers/index.js
 * @description Registry for the multi-provider chat harness (Phase E, §3.1).
 * One module per provider implements the common chat interface
 * (`isConfigured`, `listModels`, `chatStream`, optional `generateImage`); this
 * file is the single place routes reach for "give me provider X" and
 * "describe every provider for the picker".
 *
 * The GPT/OpenAI slot has NO adapter on purpose - ChatGPT free has no API (see
 * PLAN constraints). It appears in the status list as an honest, disabled
 * "needs OpenAI API key" entry so the UI can render the slot without pretending
 * it works.
 *
 * @author Jarvis (Phase E)
 */

const gemini = require("./gemini");
const ollama = require("./ollama");
const claude = require("./claude");
const config = require("./config");

const CHAT_PROVIDERS = { gemini, ollama, claude };

/** The adapter for a chat provider, or null for an unknown/absent one. */
function getChatProvider(name) {
  return CHAT_PROVIDERS[name] || null;
}

/**
 * Describe every provider for the Chat page picker + Settings. Async because
 * Ollama's model list is discovered live from its host. Never throws - a
 * provider that errors while listing models yields an empty model list, not a
 * failed page.
 */
async function getProvidersStatus() {
  const cfg = config.getConfig();
  const out = [];

  for (const [id, mod] of Object.entries(CHAT_PROVIDERS)) {
    const pcfg = cfg[id] || {};
    let models = [];
    try {
      const listed = mod.listModels();
      models = listed && typeof listed.then === "function" ? await listed : listed;
    } catch {
      models = [];
    }
    out.push({
      id,
      label: mod.label,
      enabled: Boolean(pcfg.enabled),
      configured: mod.isConfigured(),
      capabilities: mod.capabilities || { chat: true, image: false },
      models: Array.isArray(models) ? models : [],
      defaultModel: pcfg.defaultModel || (models[0] && models[0].id) || null,
    });
  }

  // GPT slot - present but never functional until a key is supplied. No adapter.
  out.push({
    id: "openai",
    label: "GPT",
    enabled: Boolean(cfg.openai?.enabled),
    configured: false,
    capabilities: { chat: true, image: true },
    models: [],
    defaultModel: null,
    disabled: true,
    note: "needs OpenAI API key - ChatGPT free has no API",
  });

  return out;
}

module.exports = {
  getChatProvider,
  getProvidersStatus,
  // Re-export config surface so routes have one import.
  getConfig: config.getConfig,
  updateConfig: config.updateConfig,
  redactedConfig: config.redactedConfig,
};
