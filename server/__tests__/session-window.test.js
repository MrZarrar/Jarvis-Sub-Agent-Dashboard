/**
 * @file Unit tests for the local session-usage window logic (routes/stats.js).
 * Exercises the pure anchoring helper `windowFromTimes` - the rolling 5-hour
 * subscription window reproduced from event timestamps, with zero API calls.
 * @author Jarvis Dashboard
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");

// Point the DB at a throwaway file before requiring the route (it pulls in db).
process.env.DASHBOARD_DB_PATH = path.join(
  os.tmpdir(),
  `dashboard-swtest-${Date.now()}-${process.pid}.db`
);

const stats = require("../routes/stats");
const windowFromTimes = stats.__windowFromTimes;
const WIN = stats.__SESSION_WINDOW_MS;
const computeMergedSessionWindow = stats.__computeMergedSessionWindow;
const usagePoller = require("../lib/usage-poller");

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const min = (n) => n * 60 * 1000;

describe("session window (windowFromTimes)", () => {
  it("returns idle when there are no events", () => {
    assert.deepEqual(windowFromTimes([], NOW), {
      active: false,
      startedAt: null,
      resetsAt: null,
      eventsInWindow: 0,
    });
  });

  it("anchors to first activity and resets exactly 5h later", () => {
    const start = NOW - min(90); // window opened 90 min ago
    const w = windowFromTimes([start, NOW - min(60), NOW - min(5)], NOW);
    assert.equal(w.active, true);
    assert.equal(w.startedAt, new Date(start).toISOString());
    assert.equal(w.resetsAt, new Date(start + WIN).toISOString());
    assert.equal(w.eventsInWindow, 3);
  });

  it("does not reset while activity stays within 5h of the anchor", () => {
    const start = NOW - min(280); // 4h40m ago - still inside the 5h window
    const w = windowFromTimes([start, NOW - min(10)], NOW);
    assert.equal(w.active, true);
    assert.equal(w.startedAt, new Date(start).toISOString());
    assert.equal(w.eventsInWindow, 2);
  });

  it("opens a fresh window when a message lands past the previous window end", () => {
    const oldAnchor = NOW - min(400); // ~6h40m ago (expired window)
    const newAnchor = NOW - min(30); // reopened 30 min ago
    const w = windowFromTimes([oldAnchor, oldAnchor + min(20), newAnchor, NOW - min(2)], NOW);
    assert.equal(w.active, true);
    assert.equal(w.startedAt, new Date(newAnchor).toISOString());
    // Only the two events in the current window are counted, not the old ones.
    assert.equal(w.eventsInWindow, 2);
  });

  it("returns idle when the anchored window has expired with no newer activity", () => {
    const start = NOW - min(360); // 6h ago; window ended an hour back
    const w = windowFromTimes([start, start + min(10)], NOW);
    assert.equal(w.active, false);
    assert.equal(w.resetsAt, null);
  });

  it("ignores unparseable timestamps", () => {
    const start = NOW - min(30);
    const w = windowFromTimes([NaN, start, NaN, NOW], NOW);
    assert.equal(w.active, true);
    assert.equal(w.eventsInWindow, 2);
  });
});

describe("merged session window (computeMergedSessionWindow)", () => {
  afterEach(() => {
    usagePoller.__reset();
  });

  it("falls back to the heuristic (source: estimated) when the poller has no reading", () => {
    const w = computeMergedSessionWindow(NOW);
    assert.equal(w.source, "estimated");
    assert.equal(w.status, null);
    assert.equal(w.isUsingOverage, null);
    assert.equal(w.probeAgeMs, null);
    // Still the same idle shape the pure heuristic returns with no DB rows.
    assert.equal(w.active, false);
  });

  it("prefers the real poller reading (source: real) once one exists", () => {
    // resetsAt is epoch SECONDS in the real payload (Anthropic's format).
    const resetsAtSec = Math.floor(NOW / 1000) + 3 * 60 * 60; // resets in 3h
    usagePoller.__setCacheForTest({
      rateLimitInfo: {
        status: "allowed",
        resetsAt: resetsAtSec,
        rateLimitType: "five_hour",
        isUsingOverage: false,
      },
      fetchedAt: NOW - 1000, // read 1s ago
    });
    const w = computeMergedSessionWindow(NOW);
    assert.equal(w.source, "real");
    assert.equal(w.active, true);
    assert.equal(w.status, "allowed");
    assert.equal(w.isUsingOverage, false);
    assert.equal(w.probeAgeMs, 1000);
    assert.equal(w.resetsAt, new Date(resetsAtSec * 1000).toISOString());
    // startedAt is derived exactly as resetsAt - 5h, not approximated.
    assert.equal(w.startedAt, new Date(resetsAtSec * 1000 - WIN).toISOString());
  });

  it("reports active:false once the real reading's window has passed", () => {
    const resetsAtSec = Math.floor(NOW / 1000) - 60; // reset 1 min ago
    usagePoller.__setCacheForTest({
      rateLimitInfo: { status: "allowed", resetsAt: resetsAtSec, rateLimitType: "five_hour" },
      fetchedAt: NOW - 1000,
    });
    const w = computeMergedSessionWindow(NOW);
    assert.equal(w.source, "real");
    assert.equal(w.active, false);
  });

  it("falls back to estimated when the poller only has an error, no reading yet", () => {
    usagePoller.__setCacheForTest({
      rateLimitInfo: null,
      fetchedAt: null,
      error: "probe timed out",
    });
    const w = computeMergedSessionWindow(NOW);
    assert.equal(w.source, "estimated");
  });
});
