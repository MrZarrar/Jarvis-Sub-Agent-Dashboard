const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseJson } = require("../lib/codex-remote");

describe("Codex Remote output", () => {
  it("parses clean JSON and tolerates non-JSON CLI prelude", () => {
    assert.deepEqual(parseJson('{"running":true}'), { running: true });
    assert.deepEqual(parseJson('warning\n{"manualPairingCode":"ABCD"}\n'), {
      manualPairingCode: "ABCD",
    });
  });
});
