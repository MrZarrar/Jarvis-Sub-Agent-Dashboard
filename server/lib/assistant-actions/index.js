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
 *   - `parseProviderDirective`  turn "use claude" / "switch to GPT" into a
 *                          per-conversation sticky provider preference.
 *
 * An explicit/sticky provider choice wins. Otherwise routine work goes to hosted
 * Groq, complex work to subscription-backed Codex, and long/multimodal input to
 * Gemini. Every tool-capable provider uses the same gated action registry.
 *
 * @author Jarvis (Phase M1)
 */

const { toSpeech } = require("../brain/speech");
const brain = require("../brain");
const providers = require("../providers");
const registry = require("./registry");
const { dispatch } = require("./dispatcher");
const { runWithTools } = require("./agent-loop");

const KNOWN_PROVIDERS = new Set(["groq", "gemini", "claude", "codex", "openai"]);
const COLLECT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_VAULT_CONTEXT_CHARS = 8_000;
const VAULT_STOP_WORDS = new Set([
  "about",
  "are",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "her",
  "his",
  "how",
  "its",
  "number",
  "our",
  "tell",
  "that",
  "the",
  "their",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "your",
]);
const MODEL_BY_TASK_CLASS = Object.freeze({
  groq: {
    simple: "openai/gpt-oss-20b",
    standard: "openai/gpt-oss-20b",
    complex: "openai/gpt-oss-120b",
  },
  codex: { simple: "gpt-5.6-luna", standard: "gpt-5.6-terra", complex: "gpt-5.6-sol" },
  claude: { simple: "haiku", standard: "sonnet", complex: "opus" },
});

// conversationId → provider id (ephemeral, like the brain's turn buffer).
const stickyProvider = new Map();

/**
 * Detect a spoken provider directive. Returns { provider, remainder } where
 * remainder is the message with the directive stripped (empty if the whole
 * message WAS the directive). Returns null when no directive is present.
 */
function parseProviderDirective(text) {
  const re =
    /\b(?:use|switch to|talk to|answer with|via)\s+(groq|gemini|claude|codex|openai|chatgpt|gpt)\b\.?/i;
  const m = re.exec(String(text || ""));
  if (!m) return null;
  const spoken = m[1].toLowerCase();
  const provider = ["gpt", "chatgpt", "codex"].includes(spoken) ? "codex" : spoken;
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
async function plainCollect(mod, messages, opts = {}) {
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

function selectModel(provider, taskClass) {
  const models = MODEL_BY_TASK_CLASS[provider];
  return models ? models[taskClass] || models.standard : null;
}

function selectAutomaticProvider(text, taskClass, context = {}) {
  const needsAction =
    context.requiresTools ||
    /^\s*(?:open|launch|navigate|go\s+to|take\s+me\s+to)\b/i.test(String(text || ""));
  if (
    needsAction ||
    String(text || "").length > 6_000 ||
    context.vision ||
    context.hasImage ||
    context.hasAttachments
  ) {
    return "gemini";
  }
  if (context.vaultGrounded) return "codex";
  return taskClass === "complex" ? "codex" : "groq";
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

/** Retrieve likely personal context before the provider answers. Tool calling
 * remains available for deeper traversal, but basic recall no longer depends
 * on a small model deciding to search. */
function vaultContext(text) {
  const notes = require("../notes");
  const tokens = [
    ...new Set(
      (
        String(text)
          .toLowerCase()
          .match(/[a-z0-9_]+/g) || []
      )
        .filter((token) => token.length > 2 && !VAULT_STOP_WORDS.has(token))
        .flatMap((token) =>
          token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
            ? [token, token.slice(0, -1)]
            : [token]
        )
    ),
  ].slice(0, 8);
  const scored = new Map();
  for (const token of tokens) {
    for (const row of notes.listNotes({ q: token, limit: 20 })) {
      const entry = scored.get(row.id) || { row, score: 0, matches: new Set(), titleHits: 0 };
      entry.matches.add(token);
      entry.score += 1;
      if (
        String(row.title || "")
          .toLowerCase()
          .includes(token)
      ) {
        entry.titleHits++;
        entry.score += 3;
      }
      scored.set(row.id, entry);
    }
  }
  const candidates = [...scored.values()]
    .filter((entry) => entry.titleHits || entry.matches.size >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const chunks = [];
  let length = 0;
  for (const { row } of candidates) {
    const note = notes.getNote(row.id);
    if (!note?.body) continue;
    const chunk = `### ${row.title}\n${note.body.slice(0, 5_000)}`;
    if (length + chunk.length > MAX_VAULT_CONTEXT_CHARS) break;
    chunks.push(chunk);
    length += chunk.length;
  }
  return chunks.length
    ? "Relevant vault context retrieved locally. Use it when it answers the question; ignore unrelated notes. For read-only recall, one matching identity is enough: answer from it without asking for confirmation. Ask only when this context contains multiple real candidates, and never invent an alternative identity. Do not claim the information is unavailable without checking this context:\n\n" +
        chunks.join("\n\n")
    : "";
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
  // Mint a conversation id on the first turn so the brain's multi-turn buffer
  // actually accumulates context. Without this, respond() only echoed back the
  // id it was given - null on turn one - so the client stored null and every
  // turn was amnesiac (brain.remember/history are no-ops on a null id).
  if (!conversationId) conversationId = require("node:crypto").randomUUID();

  // 1. Spoken provider directive → sticky preference.
  let userText = String(text || "");
  const directive = parseProviderDirective(userText);
  if (directive && conversationId) stickyProvider.set(conversationId, directive.provider);
  if (directive) {
    userText = directive.remainder;
    if (!userText) {
      // The whole message was "use claude" - acknowledge and stop.
      const label =
        directive.provider === "codex"
          ? "GPT via Codex"
          : directive.provider[0].toUpperCase() + directive.provider.slice(1);
      const ack = `Switched to ${label}.`;
      return { text: ack, speech: ack, provider: directive.provider, actions: [], conversationId };
    }
  }

  // 2. Resolve the provider: explicit arg > sticky > directive > default.
  const explicit =
    (typeof provider === "string" &&
      KNOWN_PROVIDERS.has(provider.toLowerCase()) &&
      provider.toLowerCase()) ||
    (directive && directive.provider) ||
    (conversationId && stickyProvider.get(conversationId)) ||
    null;
  const taskClass = brain.classify(userText);
  const grounding = vaultContext(userText);
  const selected =
    explicit ||
    selectAutomaticProvider(userText, taskClass, { ...context, vaultGrounded: Boolean(grounding) });
  // Vault recall always uses the fast subscription model, even when the wording
  // itself would otherwise classify as standard/complex.
  const model = !explicit && grounding ? "gpt-5.6-luna" : selectModel(selected, taskClass);

  // Don't remember the user turn yet: the fallback path calls brain.ask() which
  // records it itself, and double-recording would poison the buffer.
  const system = [brain.systemPrompt(), grounding].filter(Boolean).join("\n\n");
  const priorHistory = brain.history(conversationId);
  const messages = buildMessages(system, priorHistory, userText);
  const ctx = { ...context, conversationId };

  const mod = providers.getChatProvider(selected);
  let answer;
  let answeredBy = selected;
  let actions = [];

  try {
    if (isToolCapable(mod) && isConfigured(mod)) {
      const out = await runWithTools({ providerMod: mod, messages, source, ctx, model });
      answer = out.text;
      actions = out.actions;
    } else if (isConfigured(mod)) {
      // Chosen provider works but has no tool-use yet: plain answer, no agency
      // beyond the prelude. ponytail: honest degradation, add callWithTools to
      // claude/ollama to upgrade this in place.
      answer = await plainCollect(mod, messages, model ? { model } : {});
    } else {
      throw new Error(`${selected} is not configured`);
    }
    if (!answer || !answer.trim()) throw new Error("empty answer");
  } catch (err) {
    if (!explicit && grounding) {
      const failed = `I couldn't query the vault with Luna: ${err?.message || String(err)}.`;
      brain.remember(conversationId, "user", userText);
      brain.remember(conversationId, "assistant", failed);
      return {
        text: failed,
        speech: toSpeech(failed),
        provider: "codex",
        model: "gpt-5.6-luna",
        actions: [],
        conversationId,
      };
    }
    // Fall back to the hosted tier router. Explicit picks report the failure;
    // automatic routing can fail over without pretending the user chose it.
    const routed = await brain.ask({
      text: userText,
      source,
      conversationId,
      systemContext: grounding,
    });
    return {
      text: routed.text,
      speech: routed.speech,
      provider: routed.provider,
      ...(explicit
        ? { requestedProvider: selected, providerError: err?.message || String(err) }
        : {}),
      actions: [],
      conversationId,
    };
  }

  brain.remember(conversationId, "user", userText);
  brain.remember(conversationId, "assistant", answer);
  return {
    text: answer,
    speech: toSpeech(answer),
    provider: answeredBy,
    model,
    actions,
    conversationId,
  };
}

module.exports = {
  dispatch,
  respond,
  parseProviderDirective,
  selectModel,
  selectAutomaticProvider,
  vaultContext,
  listActions: registry.list,
  __stickyProvider: stickyProvider,
};
