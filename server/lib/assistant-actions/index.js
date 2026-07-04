/**
 * @file assistant-actions/index.js
 * @description Public surface of the assistant action layer (Phase M, §3.1) and
 * the brain-with-agency entry point. Exposes:
 *
 *   - `dispatch`           the single gated executor (re-exported).
 *   - `listActions`        registry listing (for the popup / tests).
 *   - `respond(...)`       route a user turn to a provider and, when that
 *                          provider is tool-capable, let it call actions through
 *                          the loop; returns { text, speech, provider, actions }.
 *   - `parseProviderDirective`  turn "use claude" / "switch to gemini" into a
 *                          per-conversation sticky provider preference.
 *
 * Provider is a CHOICE (a v2 locked decision): an explicit request field wins,
 * else the conversation's sticky spoken preference, else the default (Gemini -
 * mini-Jarvis's default, and the only tool-capable provider today). A chosen
 * provider that isn't tool-capable still answers in plain text (its native
 * tool-use binding is a documented follow-up); the deterministic prelude in
 * assistant.js already gives every provider real agency for the common intents.
 *
 * @author Jarvis (Phase M1)
 */

const { toSpeech } = require("../brain/speech");
const brain = require("../brain");
const providers = require("../providers");
const registry = require("./registry");
const { dispatch } = require("./dispatcher");
const { runWithTools } = require("./agent-loop");

const KNOWN_PROVIDERS = new Set(["gemini", "claude", "ollama"]);
const DEFAULT_PROVIDER = "gemini";
const COLLECT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;

// conversationId → provider id (ephemeral, like the brain's turn buffer).
const stickyProvider = new Map();

/**
 * Detect a spoken provider directive. Returns { provider, remainder } where
 * remainder is the message with the directive stripped (empty if the whole
 * message WAS the directive). Returns null when no directive is present.
 */
function parseProviderDirective(text) {
  const re = /\b(?:use|switch to|talk to|answer with|via)\s+(gemini|claude|ollama)\b\.?/i;
  const m = re.exec(String(text || ""));
  if (!m) return null;
  const provider = m[1].toLowerCase();
  const remainder = String(text)
    .replace(re, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { provider, remainder };
}

function isToolCapable(mod) {
  return Boolean(
    mod && mod.capabilities && mod.capabilities.tools && typeof mod.callWithTools === "function"
  );
}

function isConfigured(mod) {
  try {
    return Boolean(mod && mod.isConfigured());
  } catch {
    return false;
  }
}

/** Collect a single provider's plain stream into text (honors an explicit pick). */
async function plainCollect(mod, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COLLECT_TIMEOUT_MS);
  let out = "";
  try {
    for await (const chunk of mod.chatStream(messages, { signal: controller.signal })) {
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

function buildMessages(system, history, userText) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const turn of history || []) {
    if (!turn || typeof turn.text !== "string") continue;
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.text });
  }
  messages.push({ role: "user", content: String(userText || "") });
  return messages;
}

/**
 * Route a user turn with agency.
 * @returns {Promise<{text,speech,provider,actions,conversationId,requestedProvider?,providerError?}>}
 *   `requestedProvider`/`providerError` are present ONLY when the requested
 *   provider failed and the tiered router answered instead - additive, so
 *   existing callers (Siri Shortcuts) that ignore them keep working unmodified.
 */
async function respond({
  text,
  source = "chat",
  conversationId = null,
  provider = null,
  context = {},
} = {}) {
  // 1. Spoken provider directive → sticky preference.
  let userText = String(text || "");
  const directive = parseProviderDirective(userText);
  if (directive && conversationId) stickyProvider.set(conversationId, directive.provider);
  if (directive) {
    userText = directive.remainder;
    if (!userText) {
      // The whole message was "use claude" - acknowledge and stop.
      const label = directive.provider[0].toUpperCase() + directive.provider.slice(1);
      const ack = `Switched to ${label}.`;
      return { text: ack, speech: ack, provider: directive.provider, actions: [], conversationId };
    }
  }

  // 2. Resolve the provider: explicit arg > sticky > directive > default.
  const requested =
    (typeof provider === "string" &&
      KNOWN_PROVIDERS.has(provider.toLowerCase()) &&
      provider.toLowerCase()) ||
    (directive && directive.provider) ||
    (conversationId && stickyProvider.get(conversationId)) ||
    DEFAULT_PROVIDER;

  // Don't remember the user turn yet: the fallback path calls brain.ask() which
  // records it itself, and double-recording would poison the buffer.
  const system = brain.systemPrompt();
  const priorHistory = brain.history(conversationId);
  const messages = buildMessages(system, priorHistory, userText);
  const ctx = { ...context, conversationId };

  const mod = providers.getChatProvider(requested);
  let answer;
  let answeredBy = requested;
  let actions = [];

  try {
    if (isToolCapable(mod) && isConfigured(mod)) {
      const out = await runWithTools({ providerMod: mod, messages, source, ctx });
      answer = out.text;
      actions = out.actions;
    } else if (isConfigured(mod)) {
      // Chosen provider works but has no tool-use yet: plain answer, no agency
      // beyond the prelude. ponytail: honest degradation, add callWithTools to
      // claude/ollama to upgrade this in place.
      answer = await plainCollect(mod, messages);
    } else {
      throw new Error(`${requested} is not configured`);
    }
    if (!answer || !answer.trim()) throw new Error("empty answer");
  } catch (err) {
    // Fall back to the tiered router (its own fallback chain + honest stub) so
    // the user still gets an answer - but NEVER silently: the requested provider
    // failed and whoever actually answers gets labelled `requestedProvider` +
    // `providerError` so the client can say so instead of quietly relabelling
    // the reply as if the user had picked the fallback all along.
    const routed = await brain.ask({ text: userText, source, conversationId });
    return {
      text: routed.text,
      speech: routed.speech,
      provider: routed.provider,
      requestedProvider: requested,
      providerError: err?.message || String(err),
      actions: [],
      conversationId,
    };
  }

  brain.remember(conversationId, "user", userText);
  brain.remember(conversationId, "assistant", answer);
  return { text: answer, speech: toSpeech(answer), provider: answeredBy, actions, conversationId };
}

module.exports = {
  dispatch,
  respond,
  parseProviderDirective,
  listActions: registry.list,
  __stickyProvider: stickyProvider,
};
