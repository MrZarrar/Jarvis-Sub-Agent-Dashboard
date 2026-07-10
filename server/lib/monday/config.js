/**
 * @file monday/config.js
 * @description Server-side Monday.com integration config store (Phase AD).
 * Deliberate 1:1 clone of github/config.js: a single gitignored JSON file
 * (`server/config/monday.json`) plus env fallbacks, edited through the panel's
 * inline config (`PUT /api/monday/config`). The personal API token is a secret
 * and lives ONLY here - never in the client bundle; the client only ever sees
 * `hasToken`.
 *
 * Env fallbacks (a UI-saved value in the file always wins):
 *   - MONDAY_TOKEN → token
 *
 * `MONDAY_CONFIG_PATH` overrides the file location (tests point it at a temp
 * file). Reads never throw - a missing/corrupt file yields the built-in
 * defaults so the Monday page always renders.
 *
 * @author Jarvis (Phase AD)
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  enabled: true,
  token: "",
  pollMinutes: 5,
  // The status label markDone writes (AC board write-back). Overridable for
  // boards whose "done" column label isn't the default English "Done".
  doneLabel: "Done",
});

const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 180;

function configPath() {
  return (
    process.env.MONDAY_CONFIG_PATH || path.join(__dirname, "..", "..", "config", "monday.json")
  );
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

function clampPollMinutes(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULTS.pollMinutes;
  return Math.max(MIN_POLL_MINUTES, Math.min(MAX_POLL_MINUTES, v));
}

function applyEnvFallbacks(cfg) {
  const out = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    token: typeof cfg.token === "string" ? cfg.token : DEFAULTS.token,
    pollMinutes: clampPollMinutes(cfg.pollMinutes ?? DEFAULTS.pollMinutes),
    doneLabel:
      typeof cfg.doneLabel === "string" && cfg.doneLabel.trim()
        ? cfg.doneLabel.trim()
        : DEFAULTS.doneLabel,
  };
  // Env only fills a slot the file left empty - a UI-saved value always wins.
  if (!out.token && process.env.MONDAY_TOKEN) out.token = process.env.MONDAY_TOKEN.trim();
  return out;
}

/** Full, resolved config (file + env + defaults). Includes the token - server-only. */
function getConfig() {
  return applyEnvFallbacks(readFileConfig());
}

// Whitelist the fields a client may set - never let an arbitrary key land in
// the config file.
const WRITABLE_FIELDS = ["enabled", "token", "pollMinutes", "doneLabel"];

function sanitizePatch(incoming) {
  const out = {};
  for (const field of WRITABLE_FIELDS) {
    if (incoming[field] === undefined) continue;
    if (field === "enabled") out.enabled = Boolean(incoming.enabled);
    else if (field === "token")
      out.token = typeof incoming.token === "string" ? incoming.token.trim() : "";
    else if (field === "pollMinutes") out.pollMinutes = clampPollMinutes(incoming.pollMinutes);
    else if (field === "doneLabel")
      out.doneLabel =
        typeof incoming.doneLabel === "string" && incoming.doneLabel.trim()
          ? incoming.doneLabel.trim()
          : DEFAULTS.doneLabel;
  }
  return out;
}

/**
 * Persist a partial patch (merged over the on-disk file, NOT over env - so
 * clearing the token in the UI actually clears it). Writes atomically, 0600.
 * Returns the new resolved config.
 */
function updateConfig(patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  const current = readFileConfig();
  const next = { ...current, ...sanitizePatch(patch) };
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return getConfig();
}

/**
 * Client-safe view: the token is replaced by a boolean `hasToken` so the panel
 * can show "token set / not set" without ever shipping the secret.
 */
function redactedConfig() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    hasToken: Boolean(cfg.token),
    pollMinutes: cfg.pollMinutes,
    doneLabel: cfg.doneLabel,
  };
}

module.exports = {
  DEFAULTS,
  MIN_POLL_MINUTES,
  MAX_POLL_MINUTES,
  getConfig,
  updateConfig,
  redactedConfig,
  configPath,
};
