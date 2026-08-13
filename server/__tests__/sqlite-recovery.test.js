const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = require("../compat-sqlite");
}

const { createRecovery, verifyRecovery } = require("../../scripts/lib/sqlite-recovery");

const temporaryDirectories = [];

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sqlite-recovery-"));
  temporaryDirectories.push(root);
  const dbPath = path.join(root, "source.db");
  const outputDir = path.join(root, "recovery");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE recovery_rows (value TEXT NOT NULL)");
  db.prepare("INSERT INTO recovery_rows (value) VALUES (?)").run("survives");
  return { db, dbPath, outputDir };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readRows(dbPath) {
  const db = new Database(dbPath);
  try {
    return db
      .prepare("SELECT value FROM recovery_rows ORDER BY rowid")
      .all()
      .map(({ value }) => ({ value }));
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a validated single-file recovery from a WAL database", () => {
  const { db, dbPath, outputDir } = createFixture();
  try {
    const manifest = createRecovery({
      dbPath,
      outputDir,
      nodeName: "canary-core",
      now: new Date("2026-08-13T10:20:30.000Z"),
    });

    assert.deepEqual(manifest, {
      schemaVersion: 1,
      nodeName: "canary-core",
      createdAt: "2026-08-13T10:20:30.000Z",
      sourceDatabase: dbPath,
      backupDatabase: path.join(outputDir, "canary-core-2026-08-13T10-20-30-000Z.sqlite"),
      backupSha256: sha256(
        path.join(outputDir, "canary-core-2026-08-13T10-20-30-000Z.sqlite")
      ),
      integrityCheck: "ok",
    });
    assert.deepEqual(readRows(manifest.backupDatabase), [{ value: "survives" }]);
    assert.deepEqual(verifyRecovery(path.join(outputDir, "canary-core-2026-08-13T10-20-30-000Z.manifest.json")), manifest);
    assert.equal(fs.existsSync(`${manifest.backupDatabase}-wal`), false);
    assert.equal(fs.existsSync(`${manifest.backupDatabase}-shm`), false);
  } finally {
    db.close();
  }
});

test("rejects a missing source database before creating recovery output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sqlite-recovery-"));
  temporaryDirectories.push(root);
  const outputDir = path.join(root, "recovery");

  assert.throws(
    () =>
      createRecovery({
        dbPath: path.join(root, "missing.db"),
        outputDir,
        nodeName: "canary-core",
      }),
    /source database.*does not exist/i
  );
  assert.equal(fs.existsSync(outputDir), false);
});

test("rejects an existing recovery destination without overwriting it", () => {
  const { db, dbPath, outputDir } = createFixture();
  const now = new Date("2026-08-13T10:20:30.000Z");
  const existingBackup = path.join(outputDir, "canary-core-2026-08-13T10-20-30-000Z.sqlite");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(existingBackup, "preserve me");

  try {
    assert.throws(
      () => createRecovery({ dbPath, outputDir, nodeName: "canary-core", now }),
      /destination.*already exists/i
    );
    assert.equal(fs.readFileSync(existingBackup, "utf8"), "preserve me");
  } finally {
    db.close();
  }
});

test("rejects a manifest whose recovery database no longer matches its checksum", () => {
  const { db, dbPath, outputDir } = createFixture();
  try {
    const manifest = createRecovery({
      dbPath,
      outputDir,
      nodeName: "canary-core",
      now: new Date("2026-08-13T10:20:30.000Z"),
    });
    fs.appendFileSync(manifest.backupDatabase, "tampered");

    assert.throws(
      () => verifyRecovery(path.join(outputDir, "canary-core-2026-08-13T10-20-30-000Z.manifest.json")),
      /checksum mismatch/i
    );
  } finally {
    db.close();
  }
});
