/**
 * @file brain/index.js
 * @description Mini-Jarvis brain (Phase G2). A tiered task router (simple →
 * Ollama, standard → Gemini, complex → `claude -p`) with a fallback chain and a
 * `brain_calls` log - see ./router.js. This module is the entry point callers
 * use (`ask()` → `{ text, speech, ... }`); it classifies the task, feeds recent
 * conversation turns as context, and dispatches through the router.
 *
 * Phase D shipped this as a STUB (no providers existed yet). G2 wires the real
 * router in WITHOUT changing the contract: callers (server/lib/assistant.js) and
 * the HTTP shape are untouched. When NO provider is configured - or every
 * configured one errors - `ask()` degrades to the same honest canned answer the
 * stub gave, so the assistant endpoint never hard-fails.
 *
 * @author Jarvis (Phase D; router wired Phase G2)
 */

const fs = require("node:fs");
const path = require("node:path");
const { toSpeech } = require("./speech");
const router = require("./router");
const persona = require("./persona");

// ── Bounded in-memory multi-turn buffer ────────────────────────────────────
// Makes the `conversationId` field of §3.3 a real, working part of the contract
// even before a model is wired in: turns are remembered so G2's router can feed
// them as context. Ephemeral by design (a restart clears it); G2 may promote
// this to a table when it needs durable context.
const CONV_MAX = 50; // distinct conversations retained
const TURNS_MAX = 20; // turns kept per conversation
const conversations = new Map(); // conversationId → { turns: [{role,text,at}], at }

function remember(conversationId, role, text) {
  if (!conversationId) return;
  let conv = conversations.get(conversationId);
  if (!conv) {
    conv = { turns: [], at: 0 };
    // Evict the oldest conversation when at capacity (simple LRU by last touch).
    if (conversations.size >= CONV_MAX) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of conversations) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey != null) conversations.delete(oldestKey);
    }
    conversations.set(conversationId, conv);
  }
  conv.turns.push({ role, text, at: Date.now() });
  if (conv.turns.length > TURNS_MAX) conv.turns.splice(0, conv.turns.length - TURNS_MAX);
  conv.at = Date.now();
}

/** Recent turns for a conversation (oldest first), or []. Exposed for G2. */
function history(conversationId) {
  const conv = conversationId && conversations.get(conversationId);
  return conv ? conv.turns.slice() : [];
}

// ── Task classification (real; reused by the G2 router) ─────────────────────
// Cheap, deterministic heuristic mapping a task to a tier. G2 wires each tier to
// a provider; here it only labels the response so the contract is stable and the
// Analytics page can later chart tier distribution.
const COMPLEX_HINTS =
  /\b(plan|synthesi[sz]e|analy[sz]e|compare|why|strategy|architect|design|refactor|debug|neglect|summari[sz]e across)\b/i;
const SIMPLE_HINTS = /\b(yes|no|is|are|does|did|tag|label|status|count|how many|when|what time)\b/i;

function classify(text) {
  const s = String(text || "").trim();
  if (!s) return "simple";
  if (COMPLEX_HINTS.test(s) || s.length > 400) return "complex";
  if (SIMPLE_HINTS.test(s) || s.length < 60) return "simple";
  return "standard";
}

// Honest fallback when no provider is configured (or all error) - no model call.
function stubAnswer() {
  return (
    "My brain isn't connected to a model provider yet. Add a Gemini API key or an " +
    "Ollama host in Settings → AI Providers and I'll start answering for real. " +
    'Meanwhile I can still report status, take a note (say "note: ..."), and steer or stop a run.'
  );
}

let BASE_SYSTEM = null;
function baseSystemPrompt() {
  if (BASE_SYSTEM != null) return BASE_SYSTEM;
  try {
    BASE_SYSTEM = fs.readFileSync(path.join(__dirname, "prompts", "assistant.md"), "utf8");
  } catch {
    BASE_SYSTEM = "You are Jarvis, a terse, capable personal assistant. Be direct and concrete.";
  }
  return BASE_SYSTEM;
}

// The effective system prompt = the JARVIS persona (Phase J, toggle-gated) in
// front of the assistant instructions. Composed per-call, not cached, because
// the persona toggle can flip at runtime.
function systemPrompt() {
  return persona.applyToSystem(baseSystemPrompt());
}

/**
 * Route a natural-language task and produce a reply. Dispatches through the
 * tiered provider router; falls back to an honest canned answer when no provider
 * is configured or every configured one errors. Contract unchanged from Phase D.
 *
 * @returns {Promise<{text,speech,provider,taskClass,conversationId,fellBack?}>}
 */
async function ask({ text, source = "chat", conversationId = null } = {}) {
  const taskClass = classify(text);
  remember(conversationId, "user", String(text || ""));

  let answer;
  let provider = "stub";
  let fellBack = false;
  try {
    // Feed prior turns (excluding the one we just remembered) as context.
    const prior = history(conversationId).slice(0, -1);
    const result = await router.complete({
      prompt: String(text || ""),
      system: systemPrompt(),
      taskClass,
      intent: source === "siri" ? "voice" : "chat",
      history: prior,
    });
    answer = result.text;
    provider = result.provider;
    fellBack = result.fellBack;
  } catch {
    answer = stubAnswer();
    provider = "stub";
  }

  remember(conversationId, "assistant", answer);
  return {
    text: answer,
    speech: toSpeech(answer),
    provider,
    taskClass,
    conversationId,
    fellBack,
  };
}

module.exports = { ask, classify, history };
