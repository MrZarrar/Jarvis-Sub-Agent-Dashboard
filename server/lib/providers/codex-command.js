/** Resolve the local Codex CLI even when a GUI-launched server has a sparse PATH. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathLookup(env = process.env) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, ["codex"], { encoding: "utf8", env });
  if (result.status !== 0) return null;
  const found = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return found && executable(found) ? found : null;
}

function extensionCandidates(home = os.homedir()) {
  const roots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
  ];
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [];

  for (const root of roots) {
    let extensions;
    try {
      extensions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const extension of extensions) {
      const binRoot = path.join(root, extension, "bin");
      let platformDirs;
      try {
        platformDirs = fs
          .readdirSync(binRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      const platformHint = process.platform === "darwin" ? "macos" : process.platform;
      platformDirs.sort(
        (a, b) => Number(b.includes(platformHint)) - Number(a.includes(platformHint))
      );
      for (const platformDir of platformDirs) {
        candidates.push(path.join(binRoot, platformDir, binary));
      }
    }
  }
  return candidates;
}

function isProtectedWindowsAppsShim(command) {
  return /[\\/]program files[\\/]windowsapps[\\/]/i.test(String(command || ""));
}

function resolveCodexCommand({ env = process.env, home = os.homedir(), lookup = pathLookup } = {}) {
  const override = typeof env.CODEX_CLI_COMMAND === "string" ? env.CODEX_CLI_COMMAND.trim() : "";
  if (override) return override;
  const onPath = lookup(env);
  // Microsoft Store app aliases can be discoverable and pass fs.accessSync yet
  // still reject CreateProcess with EPERM. Prefer an installed extension binary
  // for that one protected location; normal npm/standalone PATH installs win.
  if (onPath && !isProtectedWindowsAppsShim(onPath)) return onPath;
  return extensionCandidates(home).find(executable) || "codex";
}

module.exports = { resolveCodexCommand, extensionCandidates, pathLookup };
