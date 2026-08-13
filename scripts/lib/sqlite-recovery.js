const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let Database;
let openReadOnlyDatabase;
try {
  Database = require("better-sqlite3");
  openReadOnlyDatabase = (filePath) =>
    new Database(filePath, { readonly: true, fileMustExist: true });
} catch {
  Database = require("../../server/compat-sqlite");
  openReadOnlyDatabase = (filePath) => new Database(filePath, { readOnly: true });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function escapeSqliteString(filePath) {
  return filePath.replace(/'/g, "''");
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
  return path.resolve(value);
}

function recoveryNames(outputDir, nodeName, createdAt) {
  if (typeof nodeName !== "string" || !/^[a-z0-9_-]+$/i.test(nodeName)) {
    throw new TypeError("nodeName must contain only letters, numbers, hyphens, or underscores");
  }
  const stamp = createdAt.replace(/[:.]/g, "-");
  const basename = `${nodeName}-${stamp}`;
  return {
    backupDatabase: path.join(outputDir, `${basename}.sqlite`),
    manifestPath: path.join(outputDir, `${basename}.manifest.json`),
  };
}

function integrityCheck(dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  try {
    db.pragma("query_only = ON");
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity check failed for ${dbPath}: ${result}`);
    }
    return result;
  } finally {
    db.close();
  }
}

function assertNewDestination(...paths) {
  const existing = paths.find((filePath) => fs.existsSync(filePath));
  if (existing) {
    throw new Error(`Recovery destination already exists: ${existing}`);
  }
}

function writeManifestAtomically(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporaryPath, manifestPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function createRecovery({ dbPath, outputDir, nodeName, now = new Date() } = {}) {
  const sourceDatabase = requirePath(dbPath, "dbPath");
  const recoveryDirectory = requirePath(outputDir, "outputDir");
  if (!fs.existsSync(sourceDatabase)) {
    throw new Error(`Source database does not exist: ${sourceDatabase}`);
  }

  const createdAt = new Date(now).toISOString();
  const { backupDatabase, manifestPath } = recoveryNames(recoveryDirectory, nodeName, createdAt);
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  assertNewDestination(backupDatabase, manifestPath);

  const source = new Database(sourceDatabase);
  try {
    source.pragma("wal_checkpoint(FULL)");
    source.exec(`VACUUM INTO '${escapeSqliteString(backupDatabase)}'`);
  } finally {
    source.close();
  }

  const manifest = {
    schemaVersion: 1,
    nodeName,
    createdAt,
    sourceDatabase,
    backupDatabase,
    backupSha256: sha256(backupDatabase),
    integrityCheck: integrityCheck(backupDatabase),
  };
  writeManifestAtomically(manifestPath, manifest);
  return manifest;
}

function verifyRecovery(manifestPath) {
  const resolvedManifestPath = requirePath(manifestPath, "manifestPath");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Recovery manifest could not be read: ${resolvedManifestPath}`, { cause: error });
  }

  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.nodeName !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.sourceDatabase !== "string" ||
    typeof manifest.backupDatabase !== "string" ||
    !/^[a-f0-9]{64}$/i.test(manifest.backupSha256) ||
    manifest.integrityCheck !== "ok"
  ) {
    throw new Error(`Recovery manifest is invalid: ${resolvedManifestPath}`);
  }

  const backupDatabase = path.resolve(manifest.backupDatabase);
  if (!fs.existsSync(backupDatabase)) {
    throw new Error(`Recovery database does not exist: ${backupDatabase}`);
  }
  if (sha256(backupDatabase) !== manifest.backupSha256) {
    throw new Error(`Recovery checksum mismatch: ${backupDatabase}`);
  }
  integrityCheck(backupDatabase);
  return manifest;
}

module.exports = { createRecovery, verifyRecovery };
