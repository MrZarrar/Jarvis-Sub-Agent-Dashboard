/** Supported Codex Remote lifecycle wrapper. Pairing codes are never persisted. */

const { execFile } = require("node:child_process");
const { resolveCodexCommand } = require("./providers/codex-command");
const { subscriptionEnv } = require("./codex-app-server");

function run(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCodexCommand(),
      args,
      { encoding: "utf8", env: subscriptionEnv(), timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.detail = String(stderr || stdout || "").trim();
          return reject(error);
        }
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function parseJson(raw) {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Codex Remote returned invalid JSON");
  }
}

async function status() {
  try {
    const value = parseJson(await run(["app-server", "daemon", "version"]));
    return {
      running: true,
      remoteControl: value.remoteControlEnabled ?? value.remote_control_enabled ?? null,
      cliVersion: value.cliVersion || value.cli_version || null,
      serverVersion: value.serverVersion || value.server_version || null,
      handoffUrl: "https://chatgpt.com/codex",
    };
  } catch (error) {
    return {
      running: false,
      remoteControl: false,
      cliVersion: null,
      serverVersion: null,
      handoffUrl: "https://chatgpt.com/codex",
      error: error.detail || error.message,
    };
  }
}

async function start() {
  const value = parseJson(await run(["remote-control", "start", "--json"]));
  return { ...(await status()), result: value };
}

async function stop() {
  const value = parseJson(await run(["remote-control", "stop", "--json"]));
  return { ...(await status()), result: value };
}

async function pair() {
  const value = parseJson(await run(["remote-control", "pair", "--json"]));
  return {
    pairingCode: value.pairingCode || null,
    manualPairingCode: value.manualPairingCode || null,
    environmentId: value.environmentId || null,
    expiresAt: value.expiresAt || null,
  };
}

module.exports = { status, start, stop, pair, parseJson };
