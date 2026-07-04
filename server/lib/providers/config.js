/**
 * @file providers/config.js
 * @description Server-side provider configuration store for the multi-provider
 * AI harness (Phase E, §3.1 of PLAN-jarvis-master.md). Secrets (the Gemini /
 * OpenAI API keys, the Ollama host) live ONLY here - never in the client bundle
 * - and are edited through the Settings UI (`PUT /api/chat/providers`).
 *
 * Layout: a single JSON file (`server/config/providers.json`, gitignored; a
 * committed `providers.example.json` documents the shape). Env vars are a
 * zero-config fallback for the two most common secrets so a fresh checkout can
 * work without ever writing the file:
 *   - GEMINI_API_KEY  → gemini.apiKey
 *   - OLLAMA_HOST     → ollama.host
 *   - OPENAI_API_KEY  → openai.apiKey
 * A value written through the UI (persisted to the file) always wins over env.
 *
 * `PROVIDERS_CONFIG_PATH` overrides the file location (tests point it at a temp
 * file). Reads never throw - a missing/corrupt file yields the built-in
 * defaults so the Chat page always renders.
 *
 * @author Jarvis (Phase E)
 */

const fs = require("node:fs");
const path = require("node:path");

// Model-id defaults are intentionally CONFIGURABLE, not hardcoded truths: the
// live Gemini model ids drift (see §3.1 - "check the live model id at build
// time, do not hardcode from memory"). These are only the seed values the user
// edits in Settings; Ollama models are discovered live from /api/tags. Current
// as of the Gemini 3 generation (verified against ai.google.dev 2026-07-04) -
// gemini-3-pro-preview has already been retired in favor of gemini-3.1-pro-preview,
// and gemini-3.1-flash-lite-preview is scheduled to retire 2026-07-09 in favor
// of gemini-3.1-flash-lite. Re-check these before relying on them long-term.
const DEFAULTS = Object.freeze({
  gemini: {
    enabled: true,
    apiKey: "",
    chatModels: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"],
    defaultModel: "gemini-3.5-flash",
    // "Nano Banana 2" - the current generalist image model. gemini-3-pro-image
    // ("Nano Banana Pro") is the premium alternative for complex visual tasks.
    imageModel: "gemini-3.1-flash-image",
  },
  ollama: {
    enabled: true,
    host: "http://localhost:11434",
    defaultModel: "",
  },
  claude: {
    enabled: true,
    chatModels: ["sonnet", "opus", "haiku"],
    defaultModel: "sonnet",
  },
  // GPT slot is present but off until a key is supplied - ChatGPT free has no
  // API (see PLAN constraints). The Chat UI renders it as "needs OpenAI key".
  openai: {
    enabled: false,
    apiKey: "",
  },
});

function configPath() {
  return (
    process.env.PROVIDERS_CONFIG_PATH ||
    path.join(__dirname, "..", "..", "config", "providers.json")
  );
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== "object") return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function readFileConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // absent or corrupt → defaults only
  }
}

function applyEnvFallbacks(cfg) {
  const out = deepMerge(DEFAULTS, cfg);
  // Env only fills a slot the file left empty - a UI-saved value always wins.
  if (!out.gemini.apiKey && process.env.GEMINI_API_KEY)
    out.gemini.apiKey = process.env.GEMINI_API_KEY;
  if (process.env.OLLAMA_HOST && out.ollama.host === DEFAULTS.ollama.host) {
    out.ollama.host = process.env.OLLAMA_HOST;
  }
  if (!out.openai.apiKey && process.env.OPENAI_API_KEY)
    out.openai.apiKey = process.env.OPENAI_API_KEY;
  return out;
}

/** Full, resolved config (file + env + defaults). Includes secrets - server-only. */
function getConfig() {
  return applyEnvFallbacks(readFileConfig());
}

/** Config for one provider, or the frozen default if unknown. */
function getProviderConfig(name) {
  const cfg = getConfig();
  return cfg[name] || {};
}

/**
 * Persist a partial patch (deep-merged over the on-disk file, NOT over env - so
 * clearing a key in the UI actually clears it). Writes atomically. Returns the
 * new resolved config. Only known providers/fields are accepted.
 */
function updateConfig(patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  const current = readFileConfig();
  const next = {};
  for (const provider of Object.keys(DEFAULTS)) {
    const incoming = patch[provider];
    if (incoming && typeof incoming === "object") {
      next[provider] = deepMerge(
        current[provider] || {},
        sanitizeProviderPatch(provider, incoming)
      );
    } else if (current[provider]) {
      next[provider] = current[provider];
    }
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return getConfig();
}

// Whitelist the fields a client is allowed to set per provider - never let an
// arbitrary key land in the config file.
const WRITABLE_FIELDS = {
  gemini: ["enabled", "apiKey", "chatModels", "defaultModel", "imageModel"],
  ollama: ["enabled", "host", "defaultModel"],
  claude: ["enabled", "chatModels", "defaultModel"],
  openai: ["enabled", "apiKey"],
};

function sanitizeProviderPatch(provider, incoming) {
  const allowed = WRITABLE_FIELDS[provider] || [];
  const out = {};
  for (const field of allowed) {
    if (incoming[field] === undefined) continue;
    if (field === "chatModels") {
      out[field] = Array.isArray(incoming[field])
        ? incoming[field].filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
        : undefined;
    } else if (field === "enabled") {
      out[field] = Boolean(incoming[field]);
    } else if (typeof incoming[field] === "string") {
      out[field] = incoming[field].trim();
    }
    if (out[field] === undefined) delete out[field];
  }
  return out;
}

/**
 * Client-safe view: replaces secret values with a boolean `hasApiKey` so the
 * Settings UI can show "key set / not set" without ever shipping the secret.
 */
function redactedConfig() {
  const cfg = getConfig();
  return {
    gemini: {
      enabled: cfg.gemini.enabled,
      hasApiKey: Boolean(cfg.gemini.apiKey),
      chatModels: cfg.gemini.chatModels,
      defaultModel: cfg.gemini.defaultModel,
      imageModel: cfg.gemini.imageModel,
    },
    ollama: {
      enabled: cfg.ollama.enabled,
      host: cfg.ollama.host,
      defaultModel: cfg.ollama.defaultModel,
    },
    claude: {
      enabled: cfg.claude.enabled,
      chatModels: cfg.claude.chatModels,
      defaultModel: cfg.claude.defaultModel,
    },
    openai: {
      enabled: cfg.openai.enabled,
      hasApiKey: Boolean(cfg.openai.apiKey),
    },
  };
}

module.exports = {
  DEFAULTS,
  getConfig,
  getProviderConfig,
  updateConfig,
  redactedConfig,
  configPath,
};
