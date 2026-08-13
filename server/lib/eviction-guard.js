const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveControlDir(env = process.env) {
  if (env.JARVIS_CONTROL_DIR) return env.JARVIS_CONTROL_DIR;

  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Jarvis", "control");
  }

  return path.join(os.homedir(), ".jarvis", "control");
}

function loadDotEnv({ env = process.env, envPath, fsImpl = fs, osImpl = os } = {}) {
  // Node's test runner must not import a developer's real .env file. Tests
  // that need environment-file behaviour pass an explicit disposable path.
  if (env.NODE_TEST_CONTEXT && !envPath) return;

  const resolvedEnvPath = envPath || path.resolve(__dirname, "..", "..", ".env");
  if (!fsImpl.existsSync(resolvedEnvPath)) return;

  for (const line of fsImpl.readFileSync(resolvedEnvPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!env[key]) {
      env[key] = value.replace(/^~(?=\/)/, osImpl.homedir());
    }
  }
}

function assertNodeNotEvicted({ controlDir, env = process.env, fsImpl = fs } = {}) {
  // Existing test suites import server/index.js without an eviction fixture.
  // Skip only this implicit, machine-local lookup; explicit controls remain
  // fail-closed and are covered by the guard tests.
  if (env.NODE_TEST_CONTEXT && !controlDir && !env.JARVIS_CONTROL_DIR) return;

  const resolvedControlDir = controlDir || resolveControlDir(env);
  const marker = path.join(resolvedControlDir, "EVICTED");
  try {
    fsImpl.statSync(marker);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    const error = new Error(`Jarvis startup refused: cannot inspect eviction marker at ${marker}`, { cause });
    error.code = "JARVIS_EVICTION_MARKER_IO";
    throw error;
  }
  const error = new Error(`Jarvis startup refused: EVICTED marker exists at ${marker}`);
  error.code = "JARVIS_NODE_EVICTED";
  throw error;
}

function assertStartupAllowed(options = {}) {
  loadDotEnv(options);
  assertNodeNotEvicted(options);
}

module.exports = { resolveControlDir, loadDotEnv, assertNodeNotEvicted, assertStartupAllowed };
