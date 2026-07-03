/**
 * @file usage-poller.js
 * @description Periodically spawns a minimal `claude -p` call for the sole
 * purpose of reading Anthropic's real `rate_limit_event` envelope — the
 * actual, account-wide rolling 5-hour subscription usage window straight
 * from the API response, not a local reconstruction. This is the ONLY known
 * channel that carries genuine rate-limit data: it is not written to the
 * on-disk transcript and not included in any hook payload, so a hooks-only
 * signal (routes/stats.js's `windowFromTimes` heuristic) can only ever
 * approximate it. See routes/stats.js for how the two are merged.
 *
 * Explicit trade-off, per user request: each poll spends a small amount of
 * real usage (a few tokens) to get a genuinely accurate number, and — because
 * the 5-hour window is account-wide — a poll itself counts as activity, so it
 * can keep the window looking "active" even when the user personally is
 * idle. Opt out entirely with DISABLE_USAGE_PROBE=1; routes/stats.js then
 * falls back fully to the local estimate.
 *
 * Invisible everywhere else in the dashboard: the probe sets
 * JARVIS_USAGE_PROBE=1 on the spawned child, and hook-handler.js skips
 * forwarding entirely when it sees that var — so the probe never appears as
 * a session, in Activity, or in Sessions. Spawned from a neutral tmp cwd
 * (no CLAUDE.md, no project memory) with `--strict-mcp-config` and no
 * `--mcp-config` to skip MCP server startup, keeping cost and noise minimal.
 */

const { spawn: realSpawn } = require("node:child_process");
const os = require("node:os");
const { createLineParser } = require("./stream-json-parser");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min — the window is coarse (5h); no need to poll faster
const MIN_INTERVAL_MS = 30 * 1000; // floor so a bad env value can't hammer the API
const PROBE_TIMEOUT_MS = 20 * 1000; // hard cap so a wedged probe process never piles up
const PROBE_PROMPT = "Reply with only the single word: ok. Do not use any tools.";

let timer = null;
let inFlight = null;
let cache = { rateLimitInfo: null, fetchedAt: null, error: null };
// Test seam: swap in a fake child (PassThrough streams) so tests can exercise
// the parsing/kill/timeout logic without invoking the real `claude` binary.
let spawnImpl = realSpawn;

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function getIntervalMs() {
  const raw = parseInt(process.env.USAGE_PROBE_INTERVAL_MS || "", 10);
  return Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? raw : DEFAULT_INTERVAL_MS;
}

function getModel() {
  return process.env.USAGE_PROBE_MODEL || "haiku";
}

/**
 * Run one probe: spawn, capture the first `rate_limit_event`, kill the child
 * immediately (cuts off further output-token spend), and cache the result.
 * Never throws — every failure path resolves to the previous cached value
 * plus an `error` string, so a flaky probe degrades to "stale but present"
 * rather than wiping out the last known-good reading.
 *
 * De-duped: an overlapping call (manual trigger racing the timer) returns the
 * same in-flight promise instead of spawning a second `claude` process.
 */
function pollOnce() {
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve) => {
    let settled = false;
    let child = null;

    const finish = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (patch)
        cache = {
          rateLimitInfo: patch.rateLimitInfo ?? cache.rateLimitInfo,
          fetchedAt: Date.now(),
          error: patch.error ?? null,
        };
      try {
        if (child && !child.killed) child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      inFlight = null;
      resolve(cache);
    };

    const hardTimeout = setTimeout(() => finish({ error: "probe timed out" }), PROBE_TIMEOUT_MS);
    if (hardTimeout.unref) hardTimeout.unref();

    try {
      child = spawnImpl(
        "claude",
        [
          "-p",
          PROBE_PROMPT,
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          getModel(),
          "--effort",
          "low",
          "--strict-mcp-config", // no --mcp-config passed → zero MCP servers load
        ],
        {
          env: { ...process.env, JARVIS_USAGE_PROBE: "1" },
          // Neutral cwd: no project CLAUDE.md / memory to auto-load, keeping
          // the probe's input tokens fixed regardless of which project the
          // dashboard itself happens to be running from.
          cwd: os.tmpdir(),
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
    } catch (err) {
      finish({ error: err.message });
      return;
    }

    const parser = createLineParser(
      (envelope) => {
        if (envelope && envelope.type === "rate_limit_event" && envelope.rate_limit_info) {
          finish({ rateLimitInfo: envelope.rate_limit_info });
        }
      },
      () => {
        /* malformed line — the probe only cares about one envelope type */
      }
    );
    child.stdout.on("data", (chunk) => parser.push(chunk.toString("utf8")));
    child.on("error", (err) => finish({ error: err.message }));
    child.on("exit", () => finish({ error: "claude exited before emitting rate_limit_event" }));
  });
  return inFlight;
}

/** Start the recurring poll (immediate first read, then every intervalMs). No-op if DISABLE_USAGE_PROBE is set or already running. */
function startPolling() {
  if (envFlag("DISABLE_USAGE_PROBE")) return;
  if (timer) return;
  pollOnce();
  timer = setInterval(pollOnce, getIntervalMs());
  if (timer.unref) timer.unref();
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Current cached reading. `rateLimitInfo` is null until the first successful poll. */
function getCached() {
  return { ...cache };
}

function __reset() {
  stopPolling();
  inFlight = null;
  cache = { rateLimitInfo: null, fetchedAt: null, error: null };
  spawnImpl = realSpawn;
}

/** Test seam: inject a cache value directly, without spawning a real `claude`. */
function __setCacheForTest(patch) {
  cache = { rateLimitInfo: null, fetchedAt: null, error: null, ...patch };
}

/** Test seam: replace the spawn implementation with a fake (e.g. PassThrough streams). */
function __setSpawnForTest(fn) {
  spawnImpl = fn || realSpawn;
}

module.exports = {
  startPolling,
  stopPolling,
  getCached,
  pollOnce,
  __reset,
  __setCacheForTest,
  __setSpawnForTest,
};
