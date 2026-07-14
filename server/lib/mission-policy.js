/** Deterministic domain, interaction, provider, and semantic-tier policy. */

const DOMAINS = new Set(["personal", "development", "business", "generic"]);
const INTERACTIONS = new Set([
  "conversation",
  "bounded_action",
  "durable_mission",
  "scheduled_mission",
  "continuation",
]);
const TIERS = new Set(["fast", "standard", "executor", "deep_review"]);

const MODEL_CANDIDATES = Object.freeze({
  codex: {
    fast: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6"],
    standard: ["gpt-5.6-terra", "gpt-5.6", "gpt-5.6-luna"],
    executor: ["gpt-5.6-sol", "gpt-5.6"],
    deep_review: ["gpt-5.6-sol", "gpt-5.6"],
  },
  "claude-code": {
    fast: ["haiku"],
    standard: ["sonnet"],
    executor: ["opus"],
    deep_review: ["opus"],
  },
  groq: {
    fast: ["openai/gpt-oss-20b"],
    standard: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  },
  gemini: {
    fast: ["gemini-3.5-flash"],
    standard: ["gemini-3.5-flash", "gemini-3.1-pro-preview"],
  },
});

function normalizeInput(input = {}) {
  const domain = DOMAINS.has(input.domain) ? input.domain : "personal";
  const interaction = INTERACTIONS.has(input.interaction) ? input.interaction : "durable_mission";
  return { ...input, domain, interaction, prompt: String(input.prompt || "") };
}

function complexityOf(input) {
  if (TIERS.has(input.modelTier)) return input.modelTier;
  const text = input.prompt.toLowerCase();
  const executorSignals = [
    /multi[- ]repo/,
    /cross[- ]app/,
    /architecture/,
    /migrat(e|ion)/,
    /security/,
    /financial/,
    /delegate|parallel workers?/,
  ];
  if (
    input.risk === "high" ||
    input.expectedSteps >= 8 ||
    input.contextSize >= 50_000 ||
    input.multipleWorkers ||
    executorSignals.some((re) => re.test(text))
  ) {
    return input.domain === "development" && input.reviewOnly ? "deep_review" : "executor";
  }
  if (
    input.risk === "medium" ||
    input.expectedSteps >= 3 ||
    input.contextSize >= 10_000 ||
    input.requiresTools ||
    input.prompt.length > 2_000
  ) {
    return "standard";
  }
  return "fast";
}

function routeMission(raw = {}) {
  const input = normalizeInput(raw);
  const tier = complexityOf(input);
  let ownerProvider;
  let workerProvider = null;
  let reason;

  if (input.requestedProvider) {
    ownerProvider = input.requestedProvider;
    reason = `Explicit provider override: ${ownerProvider}`;
  } else if (input.domain === "generic" && input.interaction === "conversation") {
    ownerProvider = "groq";
    reason = "Generic, non-durable conversation uses Groq";
  } else if (input.domain === "generic" && input.interaction === "bounded_action") {
    ownerProvider = "gemini";
    reason = "Bounded generic action uses Gemini through Jarvis permissions";
  } else if (input.domain === "development") {
    ownerProvider = "codex";
    workerProvider = "claude-code";
    reason = "Codex owns the mission; Claude Code performs development work";
  } else {
    ownerProvider = "codex";
    reason = `${input.domain === "business" ? "Business" : "Personal"} durable work is Codex-native`;
  }

  const effectiveTier =
    ownerProvider === "groq"
      ? tier === "fast"
        ? "fast"
        : "standard"
      : ownerProvider === "gemini"
        ? "standard"
        : tier;
  return {
    domain: input.domain,
    interaction: input.interaction,
    ownerProvider,
    workerProvider,
    modelTier: effectiveTier,
    reason,
    accessType:
      ownerProvider === "codex" || ownerProvider === "claude-code"
        ? "subscription_cli"
        : "api_metered",
  };
}

function resolveModel(provider, tier, available = []) {
  const candidates =
    MODEL_CANDIDATES[provider]?.[tier] || MODEL_CANDIDATES[provider]?.standard || [];
  const ids = available.map((item) => (typeof item === "string" ? item : item.id || item.model));
  const exact = candidates.find((candidate) => ids.includes(candidate));
  if (exact) return { id: exact, substituted: exact !== candidates[0], requested: candidates[0] };
  const family = ids.find((id) => typeof id === "string" && id.startsWith("gpt-5.6"));
  if (family && provider === "codex") {
    return { id: family, substituted: family !== candidates[0], requested: candidates[0] };
  }
  const fallback = candidates[0] || null;
  return { id: fallback, substituted: false, requested: fallback };
}

module.exports = {
  DOMAINS,
  INTERACTIONS,
  TIERS,
  MODEL_CANDIDATES,
  complexityOf,
  routeMission,
  resolveModel,
};
