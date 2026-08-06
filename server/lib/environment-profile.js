/** Runtime safety profiles for development, personal workers, and company core. */

const path = require("node:path");
const os = require("node:os");

const PROFILES = Object.freeze({
  "development-local": Object.freeze({
    name: "development-local",
    label: "Local development",
    capabilities: Object.freeze({
      scheduledWork: false,
      pushNotifications: false,
      externalCallbacks: false,
      authoritativeDatabase: false,
    }),
  }),
  "worker-personal": Object.freeze({
    name: "worker-personal",
    label: "Personal worker",
    capabilities: Object.freeze({
      scheduledWork: false,
      pushNotifications: false,
      externalCallbacks: false,
      authoritativeDatabase: false,
    }),
  }),
  "production-company-core": Object.freeze({
    name: "production-company-core",
    label: "Company core",
    capabilities: Object.freeze({
      scheduledWork: true,
      pushNotifications: true,
      externalCallbacks: true,
      authoritativeDatabase: true,
    }),
  }),
});

function getProfileName(env = process.env) {
  return String(env.JARVIS_ENV_PROFILE || "development-local")
    .trim()
    .toLowerCase();
}

function getRuntimeProfile(env = process.env) {
  const name = getProfileName(env);
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown JARVIS_ENV_PROFILE "${name}". Expected one of: ${Object.keys(PROFILES).join(", ")}.`
    );
  }
  return profile;
}

function normalized(value) {
  return path.resolve(String(value)).replaceAll("/", "\\").toLowerCase();
}

function isInside(candidate, parent) {
  const child = normalized(candidate);
  const root = normalized(parent).replace(/\\+$/, "");
  return child === root || child.startsWith(`${root}\\`);
}

function assertSafeRuntime({
  env = process.env,
  dbPath,
  cwd = process.cwd(),
  homeDir = os.homedir(),
} = {}) {
  const profile = getRuntimeProfile(env);
  const resolvedDbPath = path.resolve(String(dbPath || ""));

  if (!dbPath) throw new Error(`${profile.name} requires an explicit dashboard database path.`);

  if (profile.name === "production-company-core") {
    if (String(env.JARVIS_ENABLE_PRODUCTION_CORE || "") !== "1") {
      throw new Error(
        "production-company-core is locked for a later phase. Set JARVIS_ENABLE_PRODUCTION_CORE=1 only on the authoritative company host."
      );
    }
    return profile;
  }

  if (profile.name === "development-local") {
    const sharedDir = path.join(homeDir, ".claude", "agent-dashboard");
    if (isInside(resolvedDbPath, sharedDir)) {
      throw new Error(
        "development-local cannot use the shared database under ~/.claude/agent-dashboard. Configure a disposable DASHBOARD_DATA_DIR."
      );
    }
    if (isInside(resolvedDbPath, cwd)) {
      throw new Error("development-local database must live outside the repository.");
    }
    if (
      /\\(onedrive|dropbox|icloud(?:drive)?|mobile documents)\\/i.test(normalized(resolvedDbPath))
    ) {
      throw new Error("development-local database must not live in synced storage.");
    }
  }

  return profile;
}

function capabilityEnabled(capability, env = process.env) {
  return Boolean(getRuntimeProfile(env).capabilities[capability]);
}

function profileDiagnostics({ env = process.env, dbPath = null } = {}) {
  const profile = getRuntimeProfile(env);
  return {
    ...profile,
    database: {
      path: dbPath,
      authoritative: profile.capabilities.authoritativeDatabase,
      disposable: profile.name === "development-local",
    },
  };
}

module.exports = {
  PROFILES,
  getProfileName,
  getRuntimeProfile,
  assertSafeRuntime,
  capabilityEnabled,
  profileDiagnostics,
};
