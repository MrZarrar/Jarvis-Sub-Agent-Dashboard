/**
 * @file usage-poller.js
 * @description Fallback `claude -p` probe that reads Anthropic's real
 * `rate_limit_event` envelope - the account-wide rolling 5-hour subscription
 * usage window straight from the API response, not a local reconstruction.
 *
 * Phase P demoted this from the PRIMARY source to a staleness-gated FALLBACK.
 * The primary source is now ORGANIC capture: run-spawner.js, providers/
 * claude.js, and the brain's `claude -p` calls already stream the same
 * envelope on requests the user makes anyway, and tap it into the shared
 * `usage-cache.js` at zero extra token cost (see that file). This probe only
 * matters during long idle stretches where nothing organic has sampled the
 * window - and even then it is OFF BY DEFAULT.
 *
 * Trade-off (unchanged when enabled): each poll spends a few real tokens and,
 * because the 5-hour window is account-wide, a poll itself counts as activity
 * that can keep the window looking "active" while the user is idle. That is
 * exactly why it is now opt-in.
 *
 * Controls (precedence high→low):
 *   - DISABLE_USAGE_PROBE=1      forces the probe fully off (legacy opt-out,
 *                                semantics preserved).
 *   - USAGE_PROBE_ENABLED=1      opt IN to the fallback probe (default: off).
 *   - USAGE_PROBE_STALE_MIN=N    only probe when the newest organic/probe
 *                                sample is older than N minutes (default 30;
 *                                0 = never probe, purely organic).
 *
 * Invisible everywhere else in the dashboard: the probe sets
 * JARVIS_USAGE_PROBE=1 on the spawned child, and hook-handler.js skips
 * forwarding entirely when it sees that var - so the probe never appears as
 * a session, in Activity, or in Sessions. Spawned from a neutral tmp cwd
 * (no CLAUDE.md, no project memory) with `--strict-mcp-config` and no
 * `--mcp-config` to skip MCP server startup, keeping cost and noise minimal.
 */

const { spawn: realSpawn } = require("node:child_process");
const os = require("node:os");
const { createLineParser } = require("./stream-json-parser");
const usageCache = require("./usage-cache");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min - the window is coarse (5h); no need to poll faster
const MIN_INTERVAL_MS = 30 * 1000; // floor so a bad env value can't hammer the API
const PROBE_TIMEOUT_MS = 20 * 1000; // hard cap so a wedged probe process never piles up
const DEFAULT_STALE_MIN = 30; // only probe when no sample within this many minutes
const PROBE_PROMPT = "Reply with only the single word: ok. Do not use any tools.";

let timer = null;
let inFlight = null;
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

/** Minutes an organic sample must be stale before the fallback probe fires.
 *  0 (or negative) means "never probe" - rely purely on organic capture. */
function getStaleThresholdMs() {
  const raw = parseInt(process.env.USAGE_PROBE_STALE_MIN, 10);
  const min = Number.isFinite(raw) ? raw : DEFAULT_STALE_MIN;
  return min <= 0 ? -1 : min * 60 * 1000;
}

/**
 * Should the timer actually spawn a probe right now? Only when the fallback is
 * enabled AND the freshest sample in the shared cache is older than the
 * staleness threshold (or there is no sample yet). Pure + injectable so the
 * gate is unit-testable without timers or a real spawn.
 */
function shouldProbeNow(now = Date.now()) {
  if (envFlag("DISABLE_USAGE_PROBE")) return false;
  if (!envFlag("USAGE_PROBE_ENABLED")) return false;
  const staleMs = getStaleThresholdMs();
  if (staleMs < 0) return false; // 0 = never; organic-only
  const age = usageCache.sampleAgeMs(now);
  return age === null || age >= staleMs;
}

function getModel() {
  return process.env.USAGE_PROBE_MODEL || "haiku";
}

/**
 * Run one probe: spawn, capture the first `rate_limit_event`, kill the child
 * immediately (cuts off further output-token spend), and cache the result.
 * Never throws - every failure path resolves to the previous cached value
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
      if (patch) {
        // Route through the shared cache (source "probe"). recordSample bumps
        // fetchedAt on a real reading; recordError preserves the last good
        // reading so a failed probe degrades to "stale but present".
        if (patch.rateLimitInfo) usageCache.recordSample(patch.rateLimitInfo, "probe");
        else if (patch.error) usageCache.recordError(patch.error);
      }
      try {
        if (child && !child.killed) child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      inFlight = null;
      resolve(usageCache.getCached());
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
        /* malformed line - the probe only cares about one envelope type */
      }
    );
    child.stdout.on("data", (chunk) => parser.push(chunk.toString("utf8")));
    child.on("error", (err) => finish({ error: err.message }));
    child.on("exit", () => finish({ error: "claude exited before emitting rate_limit_event" }));
  });
  return inFlight;
}

/**
 * Start the staleness-gated fallback poll. No-op unless the probe is opted in
 * (USAGE_PROBE_ENABLED) and not disabled (DISABLE_USAGE_PROBE). Even when
 * enabled, each tick only spawns a probe when organic capture has gone stale
 * (shouldProbeNow) - so an active user who runs organic Claude requests never
 * triggers a probe. The recurring timer always installs (so it can react once
 * a sample ages out) but its callback is the gated poll.
 */
function startPolling() {
  if (envFlag("DISABLE_USAGE_PROBE")) return;
  if (!envFlag("USAGE_PROBE_ENABLED")) return;
  if (timer) return;
  maybePoll();
  timer = setInterval(maybePoll, getIntervalMs());
  if (timer.unref) timer.unref();
}

/** Timer callback: probe only when the shared cache has gone stale. */
function maybePoll() {
  if (shouldProbeNow()) pollOnce();
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Current cached reading (delegates to the shared usage-cache). */
function getCached() {
  return usageCache.getCached();
}

function __reset() {
  stopPolling();
  inFlight = null;
  usageCache.__reset();
  spawnImpl = realSpawn;
}

/** Test seam: inject a cache value directly, without spawning a real `claude`. */
function __setCacheForTest(patch) {
  usageCache.__setForTest(patch);
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
  shouldProbeNow,
  __reset,
  __setCacheForTest,
  __setSpawnForTest,
};
