const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function filenames(relativeDir, extension) {
  return fs
    .readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

describe("project agent roster", () => {
  it("keeps Claude Code's development crew authoritative and unfragmented", () => {
    assert.deepEqual(filenames(".claude/agents", ".md"), [
      "forge.md",
      "ops.md",
      "scout.md",
      "sentinel.md",
    ]);
  });

  it("keeps Codex focused on mission ownership, personal work, and business work", () => {
    assert.deepEqual(filenames(".codex/agents", ".toml"), [
      "bookkeeper.toml",
      "cs-drafter.toml",
      "deal-scout.toml",
      "listing-writer.toml",
      "ops-manager.toml",
      "personal-ops.toml",
      "researcher.toml",
      "sol-supervisor.toml",
      "underwriter.toml",
      "vault-curator.toml",
    ]);
  });

  it("pins the Claude crew to the intended subscription tiers", () => {
    const expectedModels = {
      "forge.md": "sonnet",
      "ops.md": "haiku",
      "scout.md": "haiku",
      "sentinel.md": "opus",
    };

    for (const [file, model] of Object.entries(expectedModels)) {
      const source = fs.readFileSync(path.join(ROOT, ".claude", "agents", file), "utf8");
      assert.match(source, new RegExp(`^model: ${model}$`, "m"), file);
    }
  });
});
