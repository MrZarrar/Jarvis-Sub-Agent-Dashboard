/**
 * @file usage-cache.js
 * @description Shared latest-reading cache for the Claude subscription's real
 * rolling 5-hour rate-limit window (the `rate_limit_info` payload Anthropic
 * puts on `rate_limit_event` envelopes in `--output-format stream-json`).
 *
 * Phase P made usage accuracy "piggyback on real requests": several PRODUCERS
 * now write here, one CONSUMER (routes/stats.js) reads:
 *
 *   - ORGANIC taps (source: "organic") - run-spawner.js (every dashboard-
 *     spawned Claude run), providers/claude.js (Chat page + brain `claude -p`
 *     complex-tier calls). These cost ZERO extra tokens: the envelope rides on
 *     a request the user already made. This is the primary source.
 *   - PROBE (source: "probe") - usage-poller.js, now a staleness-gated
 *     fallback that only fires when no organic sample has arrived recently
 *     (and is off by default). See usage-poller.js.
 *
 * Newest sample wins. An error never wipes the last good reading: producers
 * call recordError() which preserves rateLimitInfo/fetchedAt so the window
 * degrades to "stale but present" rather than blank.
 */

// One process-wide cache. `source` is the sample source (organic|probe);
// `fetchedAt` is the epoch-ms of the last GOOD sample (not bumped by errors,
// so sample-age reflects data freshness, not poll attempts).
let cache = { rateLimitInfo: null, fetchedAt: null, source: null, error: null };

/**
 * Best-effort extraction of a 0-100 "percent used" figure from a
 * rate_limit_info payload.
 *
 * HONEST CAVEAT (Phase P, build-time verification): the exact field carrying
 * utilization is NOT confirmed - a live probe couldn't be run in the build
 * environment, and the envelope's documented fields are only `status`,
 * `resetsAt`, `rateLimitType`, `isUsingOverage`. So we read defensively across
 * the plausible names and return null when none is present. When the real
 * field is confirmed, add it to CANDIDATES; nothing else changes. Per repo
 * rules: unverified capability → null, never a fabricated number.
 *
 * A value in [0,1] is treated as a fraction and scaled to a percent; a value
 * in (1,100] is treated as an already-percent; anything else → null.
 */
const PERCENT_CANDIDATES = [
  "percentUsed",
  "percent_used",
  "utilization",
  "usagePercent",
  "usage_percent",
  "percentage",
];

function percentFromInfo(info) {
  if (!info || typeof info !== "object") return null;
  for (const key of PERCENT_CANDIDATES) {
    const raw = info[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const pct = raw > 0 && raw <= 1 ? raw * 100 : raw;
    if (pct >= 0 && pct <= 100) return Math.round(pct * 10) / 10; // one decimal
  }
  return null;
}

/**
 * Record a fresh reading. `info` is the raw `rate_limit_info` object; `source`
 * is "organic" (default) or "probe". Returns the new cache snapshot.
 *
 * Anthropic's `rate_limit_event` reports on whichever window it has something
 * to say about, not always the 5-hour one - confirmed live: a probe emitted
 * exactly one event with `rateLimitType: "seven_day"` (the weekly limit) and
 * nothing else. This cache tracks the 5-hour window only, so anything else is
 * rejected here (the one choke point every producer - organic taps and the
 * probe - writes through) rather than trusted downstream as if it were the
 * 5-hour reset. Missing `rateLimitType` (older CLI) is accepted for backward
 * compat.
 */
function recordSample(info, source = "organic") {
  if (!info || typeof info !== "object") return getCached();
  if (info.rateLimitType && info.rateLimitType !== "five_hour") return getCached();
  cache = { rateLimitInfo: info, fetchedAt: Date.now(), source, error: null };
  return getCached();
}

/**
 * Record a failed attempt WITHOUT discarding the last good reading. Keeps
 * `rateLimitInfo`, `fetchedAt`, and `source` intact so a flaky producer only
 * annotates an error rather than blanking the window.
 */
function recordError(error) {
  cache = { ...cache, error: error || "unknown error" };
  return getCached();
}

/** Convenience for stream consumers: tap one parsed envelope. Returns true if
 *  it was a rate_limit_event we recorded. No-op (false) for every other
 *  envelope type, so callers can hand it every envelope unconditionally. */
function tapEnvelope(envelope, source = "organic") {
  if (
    envelope &&
    envelope.type === "rate_limit_event" &&
    envelope.rate_limit_info &&
    typeof envelope.rate_limit_info === "object"
  ) {
    recordSample(envelope.rate_limit_info, source);
    return true;
  }
  return false;
}

/** Current cached reading (shallow copy). `rateLimitInfo` is null until the
 *  first sample from any producer. */
function getCached() {
  return { ...cache };
}

/** Age in ms of the last good sample, or null if none yet. Injectable now for
 *  tests. Used by the staleness gate (usage-poller) and stats.js. */
function sampleAgeMs(now = Date.now()) {
  return cache.fetchedAt ? Math.max(0, now - cache.fetchedAt) : null;
}

function __reset() {
  cache = { rateLimitInfo: null, fetchedAt: null, source: null, error: null };
}

/** Test seam: inject a cache value directly. */
function __setForTest(patch) {
  cache = { rateLimitInfo: null, fetchedAt: null, source: null, error: null, ...patch };
}

module.exports = {
  recordSample,
  recordError,
  tapEnvelope,
  getCached,
  sampleAgeMs,
  percentFromInfo,
  __reset,
  __setForTest,
};
