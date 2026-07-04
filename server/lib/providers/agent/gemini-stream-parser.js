/**
 * @file providers/agent/gemini-stream-parser.js
 * @description Sibling to server/lib/stream-json-parser.js (Phase E, §E2). The
 * dashboard's Run UI understands ONE envelope vocabulary — the Claude Code
 * `stream-json` shapes (system/init, assistant text+tool_use, user tool_result,
 * result). This parser reads the `gemini` CLI's line-delimited JSON output and
 * NORMALIZES it into those same envelopes so a Gemini agentic run renders in the
 * exact same conversation view with zero UI changes.
 *
 * IMPORTANT — the exact field names below are a documented BEST-EFFORT mapping
 * of the gemini CLI's stream schema and MUST be verified against the version
 * actually installed on the host (there was no gemini CLI available to probe at
 * build time — see the Phase E status note in PLAN-jarvis-master.md). The parser
 * is deliberately permissive: anything already shaped like a dashboard envelope
 * (`{type:"assistant"|"user"|"system"|"result", …}`) is passed through
 * untouched, several plausible field spellings are accepted, and an
 * unrecognized line is emitted as an inert `system`/gemini_raw envelope rather
 * than dropped or thrown. Adjust `normalize()` to match your gemini version.
 *
 * @author Jarvis (Phase E)
 */

const { createLineParser } = require("../../stream-json-parser");

// Envelope shapes are identical to what run-spawner already broadcasts.
function assistantText(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}
function assistantToolUse(id, name, input) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: input ?? {} }] },
  };
}
function userToolResult(toolUseId, content) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

/**
 * Map one parsed gemini JSON object to zero+ dashboard envelopes. Returns an
 * array (a single gemini line can imply a couple of envelopes, e.g. an init +
 * text). Never throws.
 */
function normalize(obj) {
  if (!obj || typeof obj !== "object") return [];

  // Pass-through: already a dashboard envelope.
  if (obj.type === "assistant" || obj.type === "user" || obj.type === "result") return [obj];
  if (obj.type === "system") return [obj];

  const out = [];
  const t = obj.type || obj.event || obj.kind;

  // Session / init — surface a session_id so the UI can deep-link.
  const sessionId = obj.session_id || obj.sessionId || obj.conversation_id || obj.conversationId;
  if (t === "init" || t === "start" || t === "session" || (sessionId && !obj._seenInit)) {
    out.push({ type: "system", subtype: "init", session_id: sessionId || null });
  }

  // Assistant text — several spellings the CLI might use.
  const text =
    (t === "content" || t === "text" || t === "message" || t === "assistant_text"
      ? (obj.text ?? obj.content ?? obj.delta)
      : undefined) ?? (typeof obj.response === "string" ? obj.response : undefined);
  if (typeof text === "string" && text) out.push(assistantText(text));

  // Tool call.
  if (t === "tool_call" || t === "tool_use" || t === "function_call") {
    const name = obj.name || obj.tool || obj.function || "tool";
    const id = obj.id || obj.call_id || obj.tool_call_id || `gemini-${Date.now()}`;
    out.push(assistantToolUse(id, name, obj.input ?? obj.args ?? obj.arguments));
  }

  // Tool result.
  if (t === "tool_result" || t === "function_response" || t === "observation") {
    const id = obj.tool_use_id || obj.id || obj.call_id || "";
    const content = obj.output ?? obj.result ?? obj.content ?? "";
    out.push(userToolResult(id, typeof content === "string" ? content : JSON.stringify(content)));
  }

  // Terminal result.
  if (t === "result" || t === "done" || t === "final" || t === "end") {
    out.push({
      type: "result",
      subtype: obj.error ? "error" : "success",
      is_error: Boolean(obj.error),
      result: obj.result ?? obj.summary ?? null,
      session_id: sessionId || null,
    });
  }

  // Nothing matched → keep it visible but inert, so debugging a schema mismatch
  // is possible from the conversation view instead of silent data loss.
  if (out.length === 0) out.push({ type: "system", subtype: "gemini_raw", raw: obj });

  return out;
}

/**
 * Build a parser with the SAME interface run-spawner expects from
 * createLineParser: `{ push(chunk), flush() }`. Each normalized envelope is
 * delivered to `onObject` exactly as a Claude envelope would be.
 */
function createGeminiParser(onObject, onError) {
  const inner = createLineParser((obj) => {
    for (const env of normalize(obj)) onObject(env);
  }, onError);
  return inner;
}

module.exports = { createGeminiParser, normalize };
