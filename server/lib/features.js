/** Runtime feature gates for the Codex-native Agentic OS rollout. */

const DEFAULTS = Object.freeze({
  codex_kernel: true,
  unified_missions: true,
  mobile_codex_remote: true,
  codex_schedules: true,
});

function envName(name) {
  return `JARVIS_FEATURE_${name.toUpperCase()}`;
}

function enabled(name) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) return false;
  const raw = process.env[envName(name)];
  if (raw == null || raw === "") return DEFAULTS[name];
  return !["0", "false", "off", "no"].includes(String(raw).toLowerCase());
}

function all() {
  return Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, enabled(name)]));
}

module.exports = { DEFAULTS, enabled, all };
