/**
 * @file assistant-actions/agent-loop.js
 * @description Provider-agnostic function-calling loop (Phase M, §3.1 step 2).
 * Bounded iterations of: ask the model (with the registry-derived tool specs) →
 * dispatch every tool call it makes THROUGH THE GATE (dispatcher.js) → feed the
 * results back → repeat until the model answers with plain text (or the budget
 * runs out). Any provider that implements `callWithTools(messages, tools, opts)
 * → { text, toolCalls[] }` plugs in unchanged - Gemini is the first (default
 * mini-Jarvis provider); Claude (`-p --mcp-config`) and Ollama (`tools`) can be
 * added later by giving their adapter the same method, no change here.
 *
 * Safety: the model can only ever get a `safe` action to actually run. A
 * `confirm`/`typed` action it calls comes back `needs_confirm` (never executed
 * by the model on its own) and is surfaced in `actions[]` for the human to
 * confirm in the popup - the dispatcher enforces this, this loop just relays it.
 *
 * @author Jarvis (Phase M1)
 */

const registry = require("./registry");
const { dispatch } = require("./dispatcher");

const DEFAULT_MAX_ITERS = 5;
const MAX_RESULT_CHARS = 4_000;

function truncateResult(obj) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + "…" : s;
}

/**
 * Run the tool loop against a tool-capable provider.
 * @returns {Promise<{text, actions}>} actions[] = §3.1 descriptors.
 */
async function runWithTools({
  providerMod,
  messages,
  source = "chat",
  ctx = {},
  maxIters = DEFAULT_MAX_ITERS,
} = {}) {
  const tools = registry.geminiToolSpecs();
  const convo = messages.slice();
  const actions = [];
  let text = "";

  for (let i = 0; i < maxIters; i++) {
    const res = await providerMod.callWithTools(convo, tools, {});
    text = typeof res.text === "string" ? res.text : text;
    const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
    if (!calls.length) break;

    // Record the model's tool-call turn so the follow-up round has the context.
    convo.push({ role: "assistant", content: res.text || "", toolCalls: calls });

    for (const call of calls) {
      const out = await dispatch({ name: call.name, params: call.args || {}, source, ctx });
      actions.push({
        name: out.name || call.name,
        params: call.args || {},
        status: out.status,
        ...(out.confirmToken ? { confirmToken: out.confirmToken } : {}),
        ...(out.requiresTyped ? { requiresTyped: true } : {}),
      });
      // Feed a compact result back to the model so it can continue reasoning.
      const response =
        out.status === "done"
          ? { ok: true, result: out.result || {} }
          : { ok: false, status: out.status, message: out.error || out.reason || "not executed" };
      convo.push({ role: "tool", name: call.name, response, content: truncateResult(response) });
    }
  }

  return { text, actions };
}

module.exports = { runWithTools };
