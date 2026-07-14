const { it } = require("node:test");
const assert = require("node:assert/strict");
const { cleanSpawnEnv } = require("../lib/run-spawner");

it("forces Claude Code workers onto signed-in subscription auth", () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "must-not-leak";
    const env = cleanSpawnEnv(null);
    for (const name of names) assert.equal(env[name], undefined);
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
