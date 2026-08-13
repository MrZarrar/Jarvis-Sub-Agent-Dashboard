const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { assertNodeNotEvicted, assertStartupAllowed, resolveControlDir } = require("../lib/eviction-guard");

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

test("refuses startup when the eviction marker cannot be inspected", () => {
  const controlDir = createControlDir();
  const ioError = Object.assign(new Error("access denied"), { code: "EACCES" });

  assert.throws(
    () => assertNodeNotEvicted({ controlDir, fsImpl: { statSync() { throw ioError; } } }),
    (error) => error.code === "JARVIS_EVICTION_MARKER_IO" && error.cause === ioError
  );
});

test("uses JARVIS_CONTROL_DIR when explicitly configured", () => {
  const controlDir = createControlDir();

  assert.equal(resolveControlDir({ JARVIS_CONTROL_DIR: controlDir }), controlDir);
});

test("shared startup preflight refuses a marked control directory declared in its env file", () => {
  const controlDir = createControlDir();
  const envPath = path.join(controlDir, "desktop.env");
  const env = {};
  fs.writeFileSync(path.join(controlDir, "EVICTED"), "company-core\n");
  fs.writeFileSync(envPath, `JARVIS_CONTROL_DIR=${controlDir}\n`);

  assert.throws(
    () => assertStartupAllowed({ env, envPath }),
    (error) => error.code === "JARVIS_NODE_EVICTED" && error.message.includes(controlDir)
  );
});

test("skips an implicit default control directory under NODE_TEST_CONTEXT", () => {
  const env = { NODE_TEST_CONTEXT: "child-v8" };
  const fsImpl = {
    existsSync() {
      throw new Error("implicit default control directory must not be inspected");
    },
  };

  assert.doesNotThrow(() => assertNodeNotEvicted({ env, fsImpl }));
});

test("checks an explicit JARVIS_CONTROL_DIR under NODE_TEST_CONTEXT", () => {
  const controlDir = createControlDir();
  fs.writeFileSync(path.join(controlDir, "EVICTED"), "company-core\n");

  assert.throws(
    () =>
      assertNodeNotEvicted({
        env: { NODE_TEST_CONTEXT: "child-v8", JARVIS_CONTROL_DIR: controlDir },
      }),
    (error) => error.code === "JARVIS_NODE_EVICTED"
  );
});
