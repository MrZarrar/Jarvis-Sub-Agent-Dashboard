/**
 * @file github/config.js
 * @description Server-side GitHub integration config store (Phase I, dev-workflow
 * panel). Mirrors the providers/config.js shape: a single gitignored JSON file
 * (`server/config/github.json`) plus env fallbacks, edited through the Settings
 * UI (`PUT /api/github/config`). The Personal Access Token is a secret and lives
 * ONLY here — never in the client bundle; the client only ever sees `hasPat`.
 *
 * Auth model (see server/lib/github/client.js for how it's used): if a PAT is
 * set, the REST API is used; otherwise the locally-authenticated `gh` CLI is
 * driven (zero secret storage). Either way, all GitHub calls are server-side.
 *
 * Env fallbacks (a UI-saved value in the file always wins):
 *   - GITHUB_PAT    → pat
 *   - GITHUB_REPOS  → repos   (comma/space-separated "owner/name" list)
 *
 * `GITHUB_CONFIG_PATH` overrides the file location (tests point it at a temp
 * file). Reads never throw — a missing/corrupt file yields the built-in
 * defaults so the GitHub page always renders.
 *
 * @author Jarvis (Phase I)
 */

const fs = require("node:fs");
const path = require("node:path");

// Poll cadence floor mirrors the other pollers (usage-poller MIN 30s); the
// default 5 min matches update-scheduler / usage-poller so the GitHub panel
// refreshes on the same rhythm as the rest of the dashboard.
const DEFAULTS = Object.freeze({
  enabled: true,
  pat: "",
  repos: [], // ["owner/name", ...]
  pollMinutes: 5,
});

const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 180;

function configPath() {
  return (
    process.env.GITHUB_CONFIG_PATH || path.join(__dirname, "..", "..", "config", "github.json")
  );
}

// Matches a github.com repo URL (with/without protocol, "www.", ".git" suffix,
// trailing slash, or extra path like /pulls, /tree/main) and captures owner+name.
const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:[/?#].*)?$/i;

/** Normalize one candidate token to "owner/name", or null if it isn't one. */
function normalizeRepoToken(raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) return null;
  const urlMatch = token.match(GITHUB_URL_RE);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, "")}`;
  // Plain "owner/name" — exactly one slash, no protocol/extra path.
  if (/^[^/\s]+\/[^/\s]+$/.test(token)) return token;
  return null;
}

/**
 * Parse a comma/space/newline-separated repo list. Accepts bare "owner/name"
 * or a full github.com URL (copy-pasted from the address bar) — dropping
 * anything else. Deduplicates while preserving order.
 */
function parseRepoList(value) {
  const tokens = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const out = [];
  for (const t of tokens) {
    const norm = normalizeRepoToken(t);
    if (norm && !out.includes(norm)) out.push(norm);
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

function clampPollMinutes(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULTS.pollMinutes;
  return Math.max(MIN_POLL_MINUTES, Math.min(MAX_POLL_MINUTES, v));
}

function applyEnvFallbacks(cfg) {
  const out = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    pat: typeof cfg.pat === "string" ? cfg.pat : DEFAULTS.pat,
    repos: parseRepoList(cfg.repos),
    pollMinutes: clampPollMinutes(cfg.pollMinutes ?? DEFAULTS.pollMinutes),
  };
  // Env only fills a slot the file left empty — a UI-saved value always wins.
  if (!out.pat && process.env.GITHUB_PAT) out.pat = process.env.GITHUB_PAT.trim();
  if (out.repos.length === 0 && process.env.GITHUB_REPOS) {
    out.repos = parseRepoList(process.env.GITHUB_REPOS);
  }
  return out;
}

/** Full, resolved config (file + env + defaults). Includes the PAT — server-only. */
function getConfig() {
  return applyEnvFallbacks(readFileConfig());
}

// Whitelist the fields a client may set — never let an arbitrary key land in
// the config file.
const WRITABLE_FIELDS = ["enabled", "pat", "repos", "pollMinutes"];

function sanitizePatch(incoming) {
  const out = {};
  for (const field of WRITABLE_FIELDS) {
    if (incoming[field] === undefined) continue;
    if (field === "enabled") out.enabled = Boolean(incoming.enabled);
    else if (field === "pat") out.pat = typeof incoming.pat === "string" ? incoming.pat.trim() : "";
    else if (field === "repos") out.repos = parseRepoList(incoming.repos);
    else if (field === "pollMinutes") out.pollMinutes = clampPollMinutes(incoming.pollMinutes);
  }
  return out;
}

/**
 * Persist a partial patch (merged over the on-disk file, NOT over env — so
 * clearing the PAT in the UI actually clears it). Writes atomically, 0600.
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
 * Client-safe view: the PAT is replaced by a boolean `hasPat` so the Settings
 * UI can show "token set / not set" without ever shipping the secret.
 */
function redactedConfig() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    hasPat: Boolean(cfg.pat),
    repos: cfg.repos,
    pollMinutes: cfg.pollMinutes,
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
  parseRepoList,
};
