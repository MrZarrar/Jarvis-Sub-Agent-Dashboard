/**
 * @file Unit tests for the real usage poller (server/lib/usage-poller.js).
 * Uses a fake child (PassThrough streams + EventEmitter), same pattern as
 * run.test.js, so we never invoke the real `claude` binary.
 * @author Jarvis Dashboard
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");

const poller = require("../lib/usage-poller");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = function (sig) {
    this.killed = true;
    setImmediate(() => this.emit("exit", sig === "SIGTERM" ? 143 : 0, sig || null));
  };
  return child;
}

describe("usage poller", () => {
  afterEach(() => {
    poller.__reset();
  });

  it("caches the rate_limit_info from a rate_limit_event envelope and kills the child", async () => {
    const fake = makeFakeChild();
    poller.__setSpawnForTest(() => fake);
    const resultPromise = poller.pollOnce();
    fake.stdout.write(
      `${JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1234567890, rateLimitType: "five_hour" },
      })}\n`
    );
    const result = await resultPromise;
    assert.equal(result.rateLimitInfo.status, "allowed");
    assert.equal(result.rateLimitInfo.resetsAt, 1234567890);
    assert.equal(result.error, null);
    assert.equal(fake.killed, true, "child is killed once the envelope is captured");
    assert.deepEqual(poller.getCached().rateLimitInfo, result.rateLimitInfo);
  });

  it("ignores envelopes without a rate_limit_event and non-JSON lines", async () => {
    const fake = makeFakeChild();
    poller.__setSpawnForTest(() => fake);
    const resultPromise = poller.pollOnce();
    fake.stdout.write(`not json\n`);
    fake.stdout.write(`${JSON.stringify({ type: "assistant", message: {} })}\n`);
    fake.stdout.write(
      `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } })}\n`
    );
    const result = await resultPromise;
    assert.equal(result.rateLimitInfo.status, "allowed");
  });

  it("resolves with an error (keeping prior cache) when claude exits with no rate_limit_event", async () => {
    poller.__setCacheForTest({ rateLimitInfo: { status: "allowed", resetsAt: 999 }, fetchedAt: 1 });
    const fake = makeFakeChild();
    poller.__setSpawnForTest(() => fake);
    const resultPromise = poller.pollOnce();
    fake.emit("exit", 0, null);
    const result = await resultPromise;
    assert.match(result.error, /exited before emitting/);
    // Prior good reading is preserved, not wiped out by the failed poll.
    assert.equal(result.rateLimitInfo.resetsAt, 999);
  });

  it("resolves with an error when spawn itself throws", async () => {
    poller.__setSpawnForTest(() => {
      throw new Error("ENOENT: claude not found");
    });
    const result = await poller.pollOnce();
    assert.match(result.error, /ENOENT/);
  });

  it("de-dupes overlapping calls into a single in-flight probe", async () => {
    const fake = makeFakeChild();
    let spawnCount = 0;
    poller.__setSpawnForTest(() => {
      spawnCount += 1;
      return fake;
    });
    const p1 = poller.pollOnce();
    const p2 = poller.pollOnce();
    assert.equal(p1, p2, "same promise returned for an overlapping call");
    fake.stdout.write(
      `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } })}\n`
    );
    await p1;
    assert.equal(spawnCount, 1);
  });

  it("startPolling is a no-op when DISABLE_USAGE_PROBE is set", () => {
    const fake = makeFakeChild();
    let spawnCount = 0;
    poller.__setSpawnForTest(() => {
      spawnCount += 1;
      return fake;
    });
    const orig = process.env.DISABLE_USAGE_PROBE;
    process.env.DISABLE_USAGE_PROBE = "1";
    try {
      poller.startPolling();
      assert.equal(spawnCount, 0, "no probe spawned when disabled");
    } finally {
      poller.stopPolling();
      if (orig != null) process.env.DISABLE_USAGE_PROBE = orig;
      else delete process.env.DISABLE_USAGE_PROBE;
    }
  });
});

// Phase P: the probe is now an opt-in, staleness-gated FALLBACK to organic
// capture. shouldProbeNow() is the pure gate the recurring timer consults.
describe("usage probe staleness gate (shouldProbeNow)", () => {
  const ENV_KEYS = ["USAGE_PROBE_ENABLED", "DISABLE_USAGE_PROBE", "USAGE_PROBE_STALE_MIN"];
  let saved;

  function setEnv(patch) {
    for (const k of ENV_KEYS) {
      if (k in patch) process.env[k] = patch[k];
      else delete process.env[k];
    }
  }

  afterEach(() => {
    poller.__reset();
    for (const k of ENV_KEYS) {
      if (saved && saved[k] != null) process.env[k] = saved[k];
      else delete process.env[k];
    }
    saved = undefined;
  });

  it("is off by default (not opted in)", () => {
    saved = {};
    setEnv({});
    assert.equal(poller.shouldProbeNow(), false);
  });

  it("is off when opted in but DISABLE_USAGE_PROBE overrides", () => {
    saved = {};
    setEnv({ USAGE_PROBE_ENABLED: "1", DISABLE_USAGE_PROBE: "1" });
    assert.equal(poller.shouldProbeNow(), false);
  });

  it("probes when opted in and there is no organic sample yet", () => {
    saved = {};
    setEnv({ USAGE_PROBE_ENABLED: "1" });
    assert.equal(poller.shouldProbeNow(), true);
  });

  it("does NOT probe when a fresh organic sample exists within the window", () => {
    saved = {};
    setEnv({ USAGE_PROBE_ENABLED: "1", USAGE_PROBE_STALE_MIN: "30" });
    const now = 10_000_000;
    poller.__setCacheForTest({
      rateLimitInfo: { status: "allowed", resetsAt: 1 },
      fetchedAt: now - 5 * 60 * 1000, // 5 min old, threshold 30
      source: "organic",
    });
    assert.equal(poller.shouldProbeNow(now), false);
  });

  it("probes when the newest sample is older than the staleness threshold", () => {
    saved = {};
    setEnv({ USAGE_PROBE_ENABLED: "1", USAGE_PROBE_STALE_MIN: "30" });
    const now = 10_000_000;
    poller.__setCacheForTest({
      rateLimitInfo: { status: "allowed", resetsAt: 1 },
      fetchedAt: now - 45 * 60 * 1000, // 45 min old, threshold 30
      source: "organic",
    });
    assert.equal(poller.shouldProbeNow(now), true);
  });

  it("never probes when USAGE_PROBE_STALE_MIN=0 (organic-only)", () => {
    saved = {};
    setEnv({ USAGE_PROBE_ENABLED: "1", USAGE_PROBE_STALE_MIN: "0" });
    assert.equal(poller.shouldProbeNow(), false, "no sample");
    poller.__setCacheForTest({
      rateLimitInfo: { resetsAt: 1 },
      fetchedAt: 1,
      source: "organic",
    });
    assert.equal(poller.shouldProbeNow(Date.now()), false, "even with a stale sample");
  });
});
