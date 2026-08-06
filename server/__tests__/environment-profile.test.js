const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const ORIGINAL_ENV = { ...process.env };

function freshProfile() {
  delete require.cache[require.resolve("../lib/environment-profile")];
  return require("../lib/environment-profile");
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("runtime environment profiles", () => {
  it("makes development-local non-authoritative and outbound-safe", () => {
    process.env.JARVIS_ENV_PROFILE = "development-local";
    const profile = freshProfile().getRuntimeProfile();

    assert.equal(profile.name, "development-local");
    assert.deepEqual(profile.capabilities, {
      scheduledWork: false,
      pushNotifications: false,
      externalCallbacks: false,
      authoritativeDatabase: false,
    });
  });

  it("accepts a Windows-local disposable database outside the checkout", () => {
    const profile = freshProfile();
    const dbPath = "C:\\Users\\mmush\\AppData\\Local\\Jarvis\\development\\dashboard.db";

    assert.doesNotThrow(() =>
      profile.assertSafeRuntime({
        env: { JARVIS_ENV_PROFILE: "development-local" },
        dbPath,
        cwd: "C:\\Users\\mmush\\Documents\\Jarvis\\Jarvis-Sub-Agent-Dashboard",
        homeDir: "C:\\Users\\mmush",
      })
    );
  });

  it("fails closed when development points at the shared dashboard database", () => {
    const profile = freshProfile();

    assert.throws(
      () =>
        profile.assertSafeRuntime({
          env: { JARVIS_ENV_PROFILE: "development-local" },
          dbPath: "C:\\Users\\mmush\\.claude\\agent-dashboard\\dashboard.db",
          cwd: "C:\\Users\\mmush\\Documents\\Jarvis\\Jarvis-Sub-Agent-Dashboard",
          homeDir: "C:\\Users\\mmush",
        }),
      /development-local.*shared database/i
    );
  });

  it("fails closed for checkout and synced-storage database paths", () => {
    const profile = freshProfile();
    const common = {
      env: { JARVIS_ENV_PROFILE: "development-local" },
      cwd: "C:\\Users\\mmush\\Documents\\Jarvis\\Jarvis-Sub-Agent-Dashboard",
      homeDir: "C:\\Users\\mmush",
    };

    assert.throws(
      () =>
        profile.assertSafeRuntime({ ...common, dbPath: path.join(common.cwd, "data", "dev.db") }),
      /outside the repository/i
    );
    assert.throws(
      () =>
        profile.assertSafeRuntime({
          ...common,
          dbPath: "C:\\Users\\mmush\\OneDrive\\Jarvis\\dashboard.db",
        }),
      /synced storage/i
    );
  });

  it("keeps production-company-core locked until explicitly enabled", () => {
    const profile = freshProfile();
    assert.throws(
      () =>
        profile.assertSafeRuntime({
          env: { JARVIS_ENV_PROFILE: "production-company-core" },
          dbPath: "C:\\ProgramData\\Jarvis\\dashboard.db",
          cwd: "C:\\repo",
          homeDir: "C:\\Users\\mmush",
        }),
      /JARVIS_ENABLE_PRODUCTION_CORE=1/
    );
  });
});

describe("development-local side-effect guards", () => {
  it("does not arm the scheduler", () => {
    process.env.JARVIS_ENV_PROFILE = "development-local";
    const scheduler = require("../lib/scheduler");
    scheduler.stopScheduler();
    let subscriptions = 0;

    const result = scheduler.startScheduler({
      runs: { onRunStatus: () => (subscriptions += 1) },
      missions: { onMissionStatus: () => (subscriptions += 1) },
    });

    assert.deepEqual(result, { started: false, reason: "disabled by development-local" });
    assert.equal(subscriptions, 0);
  });

  it("skips push delivery before touching subscriptions", async () => {
    process.env.JARVIS_ENV_PROFILE = "development-local";
    const push = require("../lib/push");
    const db = { prepare: () => assert.fail("development push queried the database") };

    assert.deepEqual(await push.sendPushToAll(db, "Test", "No delivery"), {
      native: false,
      pushed: 0,
      failed: 0,
      skipped: true,
      reason: "disabled by development-local",
    });
  });

  it("skips webhook delivery before building or sending a request", async () => {
    process.env.JARVIS_ENV_PROFILE = "development-local";
    process.env.DASHBOARD_DB_PATH = path.join(
      os.tmpdir(),
      `environment-profile-webhook-${process.pid}.db`
    );
    const webhooks = require("../lib/webhooks");

    assert.deepEqual(await webhooks.deliver({}, { id: "alert-1" }), {
      ok: false,
      status: null,
      attempts: 0,
      skipped: true,
      reason: "disabled by development-local",
    });
  });
});
