/**
 * @file brain/index.js
 * @description Mini-Jarvis brain — MINIMAL STUB for Phase D.
 *
 * §3.2 of PLAN-jarvis-master.md specifies the real brain as a tiered task router
 * (simple → Ollama, standard → Gemini flash, complex → `claude -p`) with a
 * fallback chain and a `brain_calls` log. That router is Phase G (G2) and depends
 * on the provider adapters from Phase E. Phase D ships the assistant endpoint
 * NOW, so this stub stands in behind the SAME contract (`ask()` → `{ text,
 * speech, ... }`) that Phase G will implement for real. When G2 lands it replaces
 * the body of `ask()` with provider dispatch; callers (server/lib/assistant.js)
 * and the HTTP contract do not change.
 *
 * The stub makes NO external model calls (no keys/providers exist yet) and is
 * deliberately honest about that rather than pretending to reason. The pieces
 * that ARE real and reusable — `classify()` and the bounded conversation buffer
 * — are kept so G2 builds on them instead of replacing them.
 *
 * @author Jarvis (Phase D)
 */

const { toSpeech } = require("./speech");

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

// Honest stub answer. Phase G replaces this with real provider output.
function stubAnswer(text, taskClass) {
  const base =
    "The Jarvis brain isn't connected to a model yet — that lands in a later phase " +
    "(providers in Phase E, the routing brain in Phase G). Right now I can report " +
    'status, take a note (say "note: ..."), and steer or stop a run. Ask me for "status".';
  // Keep the taskClass visible in the text tail for transparency/debugging; the
  // speech variant drops it (see toSpeech).
  void taskClass;
  return base;
}

/**
 * Route a natural-language task and produce a reply. STUB: returns an honest
 * canned answer (no model call). Contract is stable for Phase G.
 *
 * @returns {Promise<{text,speech,provider,taskClass,conversationId}>}
 */
async function ask({ text, source = "chat", conversationId = null } = {}) {
  const taskClass = classify(text);
  remember(conversationId, "user", String(text || ""));
  const answer = stubAnswer(text, taskClass);
  remember(conversationId, "assistant", answer);
  void source;
  return {
    text: answer,
    speech: toSpeech(answer),
    provider: "stub",
    taskClass,
    conversationId,
  };
}

module.exports = { ask, classify, history };
