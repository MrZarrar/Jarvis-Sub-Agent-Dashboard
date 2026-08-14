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

/** True when the file carries an extension Windows can actually CreateProcess. */
function hasWindowsExecutableExtension(file, env = process.env) {
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return exts.includes(path.extname(String(file)).toLowerCase());
}

function pathLookup(env = process.env) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, ["codex"], { encoding: "utf8", env });
  if (result.status !== 0) return null;
  const matches = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // An npm global install puts BOTH an extensionless Unix shim and a `.cmd`
  // wrapper on PATH, and `where` lists the shim first. The shim is a shell
  // script, so spawning it fails with ENOENT - and fs.accessSync(X_OK) won't
  // reject it, because Windows ignores the execute bit. Prefer a PATHEXT match.
  const found =
    process.platform === "win32"
      ? (matches.find((file) => hasWindowsExecutableExtension(file, env)) ?? matches[0])
      : matches[0];
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

/**
 * Native binaries shipped inside the npm package, e.g.
 * `<prefix>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/<target>/bin/codex.exe`.
 *
 * Preferred over the `codex.cmd` wrapper on Windows: Node refuses to spawn
 * `.cmd`/`.bat` without `shell: true` (CVE-2024-27980) and enabling a shell
 * would put note text on a cmd.exe command line. The real executable needs
 * neither.
 */
function vendoredCandidates(lookupDir) {
  if (process.platform !== "win32" || !lookupDir) return [];
  const vendorRoot = path.join(
    lookupDir,
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor"
  );
  let targets;
  try {
    targets = fs
      .readdirSync(vendorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return targets.map((target) => path.join(vendorRoot, target, "bin", "codex.exe"));
}

function resolveCodexCommand({ env = process.env, home = os.homedir(), lookup = pathLookup } = {}) {
  const override = typeof env.CODEX_CLI_COMMAND === "string" ? env.CODEX_CLI_COMMAND.trim() : "";
  if (override) return override;
  const onPath = lookup(env);
  // A `.cmd` shim resolves fine but cannot be spawned without a shell, so swap
  // in the native binary that npm installed alongside it when one exists.
  if (onPath && /\.(cmd|bat)$/i.test(onPath)) {
    const vendored = vendoredCandidates(path.dirname(onPath)).find(executable);
    if (vendored) return vendored;
  }
  // Microsoft Store app aliases can be discoverable and pass fs.accessSync yet
  // still reject CreateProcess with EPERM. Prefer an installed extension binary
  // for that one protected location; normal npm/standalone PATH installs win.
  if (onPath && !isProtectedWindowsAppsShim(onPath)) return onPath;
  return extensionCandidates(home).find(executable) || "codex";
}

module.exports = {
  resolveCodexCommand,
  extensionCandidates,
  vendoredCandidates,
  pathLookup,
  hasWindowsExecutableExtension,
};
