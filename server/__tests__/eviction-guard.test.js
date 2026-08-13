const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { assertNodeNotEvicted, resolveControlDir } = require("../lib/eviction-guard");

const temporaryDirectories = [];

function createControlDir() {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-eviction-guard-"));
  temporaryDirectories.push(controlDir);
  return controlDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("throws before startup when EVICTED exists", () => {
  const controlDir = createControlDir();
  fs.writeFileSync(path.join(controlDir, "EVICTED"), "company-core\n");

  assert.throws(
    () => assertNodeNotEvicted({ controlDir }),
    (error) => error.code === "JARVIS_NODE_EVICTED" && /EVICTED/.test(error.message)
  );
});

test("allows startup without the marker", () => {
  assert.doesNotThrow(() => assertNodeNotEvicted({ controlDir: createControlDir() }));
});

test("uses JARVIS_CONTROL_DIR when explicitly configured", () => {
  const controlDir = createControlDir();

  assert.equal(resolveControlDir({ JARVIS_CONTROL_DIR: controlDir }), controlDir);
});
