/**
 * @file Unit tests for the shared usage cache (server/lib/usage-cache.js) -
 * the Phase P substrate that organic taps and the fallback probe both write.
 * @author Jarvis Dashboard
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const usageCache = require("../lib/usage-cache");

describe("usage-cache", () => {
  afterEach(() => usageCache.__reset());

  it("tapEnvelope records a rate_limit_event and reports the source", () => {
    const recorded = usageCache.tapEnvelope(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 123, rateLimitType: "five_hour" },
      },
      "organic"
    );
    assert.equal(recorded, true);
    const c = usageCache.getCached();
    assert.equal(c.rateLimitInfo.resetsAt, 123);
    assert.equal(c.source, "organic");
    assert.equal(c.error, null);
    assert.ok(c.fetchedAt, "fetchedAt is stamped");
  });

  it("tapEnvelope is a no-op (false) for non-rate_limit_event envelopes", () => {
    assert.equal(usageCache.tapEnvelope({ type: "assistant", message: {} }), false);
    assert.equal(usageCache.tapEnvelope(null), false);
    assert.equal(usageCache.tapEnvelope({ type: "rate_limit_event" }), false); // no info
    assert.equal(usageCache.getCached().rateLimitInfo, null);
  });

  it("newest sample wins, and source is carried through", () => {
    usageCache.recordSample({ status: "allowed", resetsAt: 1 }, "probe");
    usageCache.recordSample({ status: "allowed", resetsAt: 2 }, "organic");
    const c = usageCache.getCached();
    assert.equal(c.rateLimitInfo.resetsAt, 2);
    assert.equal(c.source, "organic");
  });

  it("recordError preserves the last good reading (stale-but-present)", () => {
    usageCache.recordSample({ status: "allowed", resetsAt: 999 }, "organic");
    const before = usageCache.getCached().fetchedAt;
    usageCache.recordError("probe timed out");
    const c = usageCache.getCached();
    assert.equal(c.rateLimitInfo.resetsAt, 999, "reading kept");
    assert.equal(c.source, "organic", "source kept");
    assert.equal(c.fetchedAt, before, "fetchedAt not bumped by an error");
    assert.match(c.error, /timed out/);
  });

  it("sampleAgeMs is the age of the last good sample (null when none)", () => {
    assert.equal(usageCache.sampleAgeMs(), null);
    usageCache.__setForTest({ rateLimitInfo: { resetsAt: 1 }, fetchedAt: 1000, source: "organic" });
    assert.equal(usageCache.sampleAgeMs(1000 + 5000), 5000);
  });

  describe("percentFromInfo", () => {
    it("reads an explicit percent field (0-100)", () => {
      assert.equal(usageCache.percentFromInfo({ percentUsed: 42 }), 42);
      assert.equal(usageCache.percentFromInfo({ utilization: 87.5 }), 87.5);
    });
    it("scales a [0,1] fraction to a percent", () => {
      assert.equal(usageCache.percentFromInfo({ utilization: 0.42 }), 42);
    });
    it("returns null when no known field is present or value is out of range", () => {
      assert.equal(usageCache.percentFromInfo({ status: "allowed", resetsAt: 1 }), null);
      assert.equal(usageCache.percentFromInfo({ percentUsed: 150 }), null);
      assert.equal(usageCache.percentFromInfo(null), null);
    });
  });
});
