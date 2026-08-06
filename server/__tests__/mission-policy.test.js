const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { routeMission, resolveModel } = require("../lib/mission-policy");

describe("mission policy", () => {
  const fixtures = [
    [{ domain: "generic", interaction: "conversation", prompt: "hello" }, "codex", null, "fast"],
    [
      {
        domain: "generic",
        interaction: "bounded_action",
        prompt: "open github",
        requiresTools: true,
      },
      "codex",
      null,
      "standard",
    ],
    [
      { domain: "personal", interaction: "durable_mission", prompt: "plan my week" },
      "codex",
      null,
      "fast",
    ],
    [
      { domain: "business", interaction: "scheduled_mission", prompt: "review inventory" },
      "codex",
      null,
      "fast",
    ],
    [
      { domain: "development", interaction: "durable_mission", prompt: "fix the parser" },
      "codex",
      "claude-code",
      "executor",
    ],
    [
      {
        domain: "personal",
        interaction: "durable_mission",
        prompt: "multi-repo architecture migration",
      },
      "codex",
      null,
      "executor",
    ],
  ];

  for (const [input, owner, worker, tier] of fixtures) {
    it(`${input.domain}/${input.interaction} routes to ${owner}`, () => {
      const result = routeMission(input);
      assert.equal(result.ownerProvider, owner);
      assert.equal(result.workerProvider, worker);
      assert.equal(result.modelTier, tier);
    });
  }

  it("keeps explicit providers explicit and never invents a fallback", () => {
    const result = routeMission({
      domain: "business",
      interaction: "durable_mission",
      prompt: "draft",
      requestedProvider: "codex",
    });
    assert.equal(result.ownerProvider, "codex");
    assert.match(result.reason, /Explicit provider override/);
  });

  it("promotes bounded multi-worker ownership to Sol without changing domain ownership", () => {
    const result = routeMission({
      domain: "business",
      interaction: "durable_mission",
      prompt: "evaluate this opportunity and prepare the implementation",
      multipleWorkers: true,
    });
    assert.equal(result.ownerProvider, "codex");
    assert.equal(result.modelTier, "executor");
  });

  it("keeps Sol as the development owner even when a lower tier is requested", () => {
    const result = routeMission({
      domain: "development",
      interaction: "durable_mission",
      prompt: "small code fix",
      modelTier: "fast",
    });
    assert.equal(result.ownerProvider, "codex");
    assert.equal(result.workerProvider, "claude-code");
    assert.equal(result.modelTier, "executor");
  });

  it("resolves semantic tiers against discovered model ids and reports substitutions", () => {
    assert.deepEqual(resolveModel("codex", "executor", [{ id: "gpt-5.6" }]), {
      id: "gpt-5.6",
      requested: "gpt-5.6-sol",
      substituted: true,
    });
    assert.equal(resolveModel("claude-code", "deep_review", ["opus"]).id, "opus");
  });

  it("does not silently downgrade a Sol mission to Luna or Terra", () => {
    assert.deepEqual(resolveModel("codex", "executor", ["gpt-5.6-terra"]), {
      id: null,
      requested: "gpt-5.6-sol",
      substituted: false,
    });
  });
});
