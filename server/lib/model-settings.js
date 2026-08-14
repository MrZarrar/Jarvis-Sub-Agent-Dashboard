/**
 * @file model-settings.js
 * @description Operator-chosen model and provider preferences for the brain
 * router, the vault entity engine, and the agent team. Stored as one JSON blob
 * in `app_settings` so a partial write can never leave the tiers disagreeing.
 *
 * An empty model string means "inherit the provider's own default" - that is a
 * meaningful choice, not a missing value, so it is preserved rather than
 * coerced to a concrete id.
 */

const { stmts } = require("../db");

const SETTINGS_KEY = "model_settings";

/** Roles the mission planner allocates work across (server/lib/missions.js). */
const AGENT_ROLES = Object.freeze(["scout", "forge", "sentinel", "ops"]);

/** Providers that can back the entity engine. Both are subscription-backed. */
const ENGINE_PROVIDERS = Object.freeze(["codex", "claude"]);

/**
 * Known model ids per provider, surfaced as UI suggestions. Codex ships no
 * enumerated `chatModels` in providers/config.js, so the GPT-5.6 tiers are
 * listed here. Free-text entry stays allowed - these lists go stale as vendors
 * ship new tiers, and blocking an unlisted id would be worse than trusting the
 * operator.
 */
const KNOWN_MODELS = Object.freeze({
  claude: Object.freeze(["sonnet", "opus", "haiku"]),
  codex: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
});

const DEFAULTS = Object.freeze({
  chat: Object.freeze({ claude: "", codex: "" }),
  // Terra for semantic cross-note reasoning, via Codex rather than Claude.
  engine: Object.freeze({ provider: "codex", model: "gpt-5.6-terra" }),
  agents: Object.freeze({ scout: "", forge: "", sentinel: "", ops: "" }),
});

const MAX_MODEL_LEN = 100;

function cleanModel(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_MODEL_LEN);
}

function get() {
  let stored = null;
  try {
    const row = stmts.getSetting.get(SETTINGS_KEY);
    if (row && typeof row.value === "string") stored = JSON.parse(row.value);
  } catch {
    stored = null; // unreadable/corrupt settings must not break routing
  }
  const chat = { ...DEFAULTS.chat };
  const agents = { ...DEFAULTS.agents };
  const engine = { ...DEFAULTS.engine };

  if (stored && typeof stored === "object") {
    if (stored.chat && typeof stored.chat === "object") {
      for (const id of Object.keys(chat)) chat[id] = cleanModel(stored.chat[id]);
    }
    if (stored.agents && typeof stored.agents === "object") {
      for (const role of AGENT_ROLES) agents[role] = cleanModel(stored.agents[role]);
    }
    if (stored.engine && typeof stored.engine === "object") {
      if (ENGINE_PROVIDERS.includes(stored.engine.provider))
        engine.provider = stored.engine.provider;
      if (typeof stored.engine.model === "string") engine.model = cleanModel(stored.engine.model);
    }
  }
  return { chat, engine, agents };
}

/** Merge a partial update over current settings. Returns the stored result. */
function update(patch) {
  const current = get();
  const next = {
    chat: { ...current.chat },
    engine: { ...current.engine },
    agents: { ...current.agents },
  };

  if (patch && typeof patch === "object") {
    if (patch.chat && typeof patch.chat === "object") {
      for (const id of Object.keys(next.chat)) {
        if (id in patch.chat) next.chat[id] = cleanModel(patch.chat[id]);
      }
    }
    if (patch.agents && typeof patch.agents === "object") {
      for (const role of AGENT_ROLES) {
        if (role in patch.agents) next.agents[role] = cleanModel(patch.agents[role]);
      }
    }
    if (patch.engine && typeof patch.engine === "object") {
      if ("provider" in patch.engine) {
        if (!ENGINE_PROVIDERS.includes(patch.engine.provider)) {
          const err = new Error(`engine.provider must be one of ${ENGINE_PROVIDERS.join(", ")}`);
          err.code = "EBADINPUT";
          throw err;
        }
        next.engine.provider = patch.engine.provider;
      }
      if ("model" in patch.engine) next.engine.model = cleanModel(patch.engine.model);
    }
  }

  stmts.setSetting.run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Provider order for the entity engine: the chosen provider first, the other
 * kept as a fallback so a signed-out CLI degrades instead of hard-failing the
 * whole pass. `router.complete` reports `fellBack` when that happens.
 */
function engineOrder() {
  const { provider } = get().engine;
  return [provider, ...ENGINE_PROVIDERS.filter((id) => id !== provider)];
}

/** `providerOptions` shape for router.complete - only the chosen provider is pinned. */
function engineProviderOptions() {
  const { provider, model } = get().engine;
  return model ? { [provider]: { model } } : {};
}

/** Model for one agent role, or null to inherit the provider default. */
function agentModel(role) {
  const key = String(role || "")
    .trim()
    .toLowerCase();
  const model = get().agents[key];
  return model || null;
}

module.exports = {
  AGENT_ROLES,
  ENGINE_PROVIDERS,
  KNOWN_MODELS,
  DEFAULTS,
  get,
  update,
  engineOrder,
  engineProviderOptions,
  agentModel,
};
