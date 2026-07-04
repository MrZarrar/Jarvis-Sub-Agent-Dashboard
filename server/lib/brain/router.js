/**
 * @file brain/router.js
 * @description Mini-Jarvis brain ROUTER (Phase G2, §3.2). Not a chatbot — a task
 * router that sends each brain task to the cheapest capable provider and falls
 * back gracefully when one is unconfigured, errors, or is rate-limited (429).
 *
 * Tiers (from classify() in ./index.js):
 *   simple   → Ollama   (tag extraction, yes/no triage — local, free, fast)
 *   standard → Gemini   (brain-dump reformatting, briefing/notification copy)
 *   complex  → claude -p (multi-note synthesis, "what am I neglecting", planning)
 *
 * Fallback order per tier degrades to whatever IS configured (never queue-and-
 * hang on a 429 — the plan's hard constraint). Every call is logged to the
 * `brain_calls` table (task class, provider, latency, fell-back, error) for the
 * Analytics page. Fail-safe: a logging failure never blocks the answer, and if
 * NO provider is configured `complete()` throws `ENOPROVIDER` so callers can give
 * an honest "brain isn't wired up yet" reply.
 *
 * @author Jarvis (Phase G)
 */

const { randomUUID } = require("node:crypto");
const { stmts } = require("../../db");
const providers = require("../providers");

// Candidate order per tier. The first CONFIGURED provider is the primary; the
// rest are fallbacks tried in order on error/429. Configurable-by-design — a
// later Settings surface can override these; the defaults follow §3.2.
const TIER_ORDER = {
  simple: ["ollama", "gemini", "claude"],
  standard: ["gemini", "ollama", "claude"],
  complex: ["claude", "gemini", "ollama"],
};

const COLLECT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;

/**
 * Run one brain task and return its text plus routing metadata.
 * @param {object} args
 * @param {string} args.prompt   The user/task text.
 * @param {string} [args.system] System instruction.
 * @param {string} [args.taskClass] simple|standard|complex (defaults standard).
 * @param {string} [args.intent] Free label for the log (reformat|pulse|chat…).
 * @param {Array}  [args.history] Prior {role,text} turns for context.
 * @returns {Promise<{text,provider,taskClass,fellBack}>}
 */
async function complete({
  prompt,
  system = null,
  taskClass = "standard",
  intent = "chat",
  history = [],
} = {}) {
  const order = TIER_ORDER[taskClass] || TIER_ORDER.standard;
  const messages = buildMessages({ system, prompt, history });

  const candidates = order
    .map((id) => ({ id, mod: providers.getChatProvider(id) }))
    .filter((c) => c.mod && safeConfigured(c.mod));

  if (!candidates.length) {
    logCall({
      taskClass,
      provider: null,
      intent,
      ok: 0,
      fellBack: 0,
      latencyMs: 0,
      error: "no provider configured",
    });
    const err = new Error("no brain provider is configured");
    err.code = "ENOPROVIDER";
    throw err;
  }

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const { id, mod } = candidates[i];
    const started = Date.now();
    try {
      const text = await collect(mod, messages, { taskClass });
      const latencyMs = Date.now() - started;
      logCall({
        taskClass,
        provider: id,
        intent,
        ok: 1,
        fellBack: i > 0 ? 1 : 0,
        latencyMs,
        error: null,
      });
      return { text, provider: id, taskClass, fellBack: i > 0 };
    } catch (err) {
      lastErr = err;
      logCall({
        taskClass,
        provider: id,
        intent,
        ok: 0,
        fellBack: i > 0 ? 1 : 0,
        latencyMs: Date.now() - started,
        error: err?.message || String(err),
      });
      // try the next configured provider
    }
  }
  const err = new Error(`all brain providers failed: ${lastErr?.message || "unknown"}`);
  err.code = "EALLFAILED";
  throw err;
}

function buildMessages({ system, prompt, history }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const turn of history || []) {
    if (!turn || typeof turn.text !== "string") continue;
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.text });
  }
  messages.push({ role: "user", content: String(prompt || "") });
  return messages;
}

/** Consume a provider's streaming chat into a single string, with a hard timeout
 *  so a hung provider degrades to a fallback rather than blocking the request. */
async function collect(mod, messages, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COLLECT_TIMEOUT_MS);
  let out = "";
  try {
    for await (const chunk of mod.chatStream(messages, { ...opts, signal: controller.signal })) {
      if (chunk && typeof chunk.text === "string") {
        out += chunk.text;
        if (out.length > MAX_OUTPUT_CHARS) break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!out.trim()) throw new Error("provider returned no text");
  return out.trim();
}

function safeConfigured(mod) {
  try {
    return Boolean(mod.isConfigured());
  } catch {
    return false;
  }
}

/** Best-effort insert into brain_calls. Never throws. */
function logCall({ taskClass, provider, intent, ok, fellBack, latencyMs, tokens = null, error }) {
  try {
    stmts.insertBrainCall.run({
      id: randomUUID(),
      task_class: taskClass || null,
      provider: provider || null,
      intent: intent || null,
      ok: ok ? 1 : 0,
      fell_back: fellBack ? 1 : 0,
      latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      tokens: tokens == null ? null : Number(tokens),
      error: error || null,
    });
  } catch {
    /* logging is a side benefit, never a blocker */
  }
}

/** Is any brain provider configured right now? Used by callers to decide between
 *  a real answer and an honest "not wired up" stub. */
function anyProviderConfigured() {
  for (const id of ["gemini", "ollama", "claude"]) {
    const mod = providers.getChatProvider(id);
    if (mod && safeConfigured(mod)) return true;
  }
  return false;
}

module.exports = { complete, anyProviderConfigured, TIER_ORDER };
