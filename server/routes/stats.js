/**
 * @file Express router for stats endpoints, providing aggregated statistics about agents, sessions, events, and WebSocket connections. It queries the database for various counts and statuses, and returns a comprehensive overview in JSON format for frontend display on the dashboard.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { stmts } = require("../db");
const { getConnectionCount } = require("../websocket");

const router = Router();

// The Claude subscription usage limit runs in a rolling 5-hour window anchored
// to the first message of the window; it resets exactly 5 hours later, and the
// next message after that opens a fresh window. We reproduce that anchoring
// locally from event timestamps only - no API calls, so no usage is consumed
// and there is zero exposure to overage billing. This is an approximation of
// Claude's official number, not the exact subscription figure.
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

const IDLE_WINDOW = { active: false, startedAt: null, resetsAt: null, eventsInWindow: 0 };

/**
 * Pure anchoring logic (no DB) - testable in isolation. Given epoch-ms
 * timestamps and the current time, derive the active anchored 5-hour window.
 * Returns an inactive window when the last activity is older than the window.
 *
 * @param {number[]} timesMs epoch-millis event timestamps (any order)
 * @param {number} now epoch millis
 */
function windowFromTimes(timesMs, now) {
  const times = timesMs.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (times.length === 0) return IDLE_WINDOW;

  // Walk forward, opening a new window whenever a message lands at/after the
  // current window's end. The last anchor is the current window's start.
  let anchor = times[0];
  for (const t of times) {
    if (t >= anchor + SESSION_WINDOW_MS) anchor = t;
  }
  const windowEnd = anchor + SESSION_WINDOW_MS;
  if (now >= windowEnd) return IDLE_WINDOW; // anchored window expired, no newer activity

  const eventsInWindow = times.reduce((n, t) => (t >= anchor ? n + 1 : n), 0);
  return {
    active: true,
    startedAt: new Date(anchor).toISOString(),
    resetsAt: new Date(windowEnd).toISOString(),
    eventsInWindow,
  };
}

/**
 * Compute the current anchored 5-hour session window from recent event
 * timestamps in the DB.
 *
 * @param {number} now epoch millis (injectable for tests)
 */
function computeSessionWindow(now = Date.now()) {
  // Look back two windows so an active window's anchor (always within 5h of
  // now) is always covered, while keeping the scan bounded and cheap.
  const boundIso = new Date(now - 2 * SESSION_WINDOW_MS).toISOString();
  let rows;
  try {
    rows = stmts.recentEventTimes.all(boundIso);
  } catch {
    return IDLE_WINDOW;
  }
  return windowFromTimes(
    rows.map((r) => Date.parse(r.created_at)),
    now
  );
}

/**
 * Merge the real usage-poller reading (server/lib/usage-poller.js) over the
 * local heuristic. The poller gets a genuine `rate_limit_info` straight from
 * Anthropic's API for a rolling "five_hour" window: `resetsAt` (epoch
 * seconds) is exact, so `startedAt` is derived exactly as `resetsAt - 5h` -
 * no approximation once we have it, unlike the timestamp heuristic. Falls
 * back to the heuristic (source: "estimated") when the poller has no reading
 * yet (server just started) or is disabled (DISABLE_USAGE_PROBE=1).
 *
 * @param {number} now epoch millis (injectable for tests)
 */
function computeMergedSessionWindow(now = Date.now()) {
  const heuristic = computeSessionWindow(now);
  let probe = null;
  try {
    probe = require("../lib/usage-poller").getCached();
  } catch {
    probe = null;
  }
  const info = probe && probe.rateLimitInfo;
  if (info && typeof info.resetsAt === "number" && probe.fetchedAt) {
    const resetsAtMs = info.resetsAt * 1000;
    const startedAtMs = resetsAtMs - SESSION_WINDOW_MS;
    return {
      active: resetsAtMs > now,
      startedAt: new Date(startedAtMs).toISOString(),
      resetsAt: new Date(resetsAtMs).toISOString(),
      eventsInWindow: heuristic.eventsInWindow,
      source: "real",
      status: typeof info.status === "string" ? info.status : null,
      isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
      probeAgeMs: now - probe.fetchedAt,
    };
  }
  return {
    ...heuristic,
    source: "estimated",
    status: null,
    isUsingOverage: null,
    probeAgeMs: null,
  };
}

router.get("/", (req, res) => {
  // Client sends tz_offset (minutes from getTimezoneOffset(), e.g. 420 for PDT)
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const offsetMin = Number.isFinite(rawOffset) ? rawOffset : 0;
  const toLocal = `${-offsetMin} minutes`; // shift UTC → local
  const toUTC = `${offsetMin} minutes`; // shift local → UTC

  const overview = stmts.stats.get();
  const agentsByStatus = stmts.agentStatusCounts.all();
  const sessionsByStatus = stmts.sessionStatusCounts.all();

  const eventsToday = stmts.countEventsToday.get(toLocal, toUTC);

  res.json({
    ...overview,
    events_today: eventsToday?.count ?? 0,
    ws_connections: getConnectionCount(),
    agents_by_status: Object.fromEntries(agentsByStatus.map((r) => [r.status, r.count])),
    sessions_by_status: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r.count])),
    session_window: computeMergedSessionWindow(),
  });
});

module.exports = router;
module.exports.__computeSessionWindow = computeSessionWindow;
module.exports.__computeMergedSessionWindow = computeMergedSessionWindow;
module.exports.__windowFromTimes = windowFromTimes;
module.exports.__SESSION_WINDOW_MS = SESSION_WINDOW_MS;
