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

function assertNodeNotEvicted({ controlDir = resolveControlDir(), fsImpl = fs } = {}) {
  const marker = path.join(controlDir, "EVICTED");
  if (fsImpl.existsSync(marker)) {
    const error = new Error(`Jarvis startup refused: EVICTED marker exists at ${marker}`);
    error.code = "JARVIS_NODE_EVICTED";
    throw error;
  }
}

module.exports = { resolveControlDir, assertNodeNotEvicted };
