/** Structured Jarvis action calling for subscription-backed CLI providers. */

const MAX_RESPONSE_CHARS = 16_000;
const TOOL_TIMEOUT_MS = 60_000;

function firstJsonObject(value) {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

function parseToolResponse(raw) {
  const fallback = String(raw || "").trim();
  let candidate = fallback.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    candidate = JSON.parse(candidate);
  } catch {
    const object = firstJsonObject(candidate);
    if (!object) return { text: fallback, toolCalls: [] };
    try {
      candidate = JSON.parse(object);
    } catch {
      return { text: fallback, toolCalls: [] };
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { text: fallback, toolCalls: [] };
  }

  const calls = Array.isArray(candidate.toolCalls)
    ? candidate.toolCalls
        .filter((call) => call && typeof call.name === "string")
        .map((call) => ({
          name: call.name,
          args:
            call.args && typeof call.args === "object" && !Array.isArray(call.args)
              ? call.args
              : {},
        }))
    : [];

  return {
    text: typeof candidate.text === "string" ? candidate.text.trim() : "",
    toolCalls: calls,
  };
}

function protocolPrompt(tools) {
  return [
    "You can control Mini Jarvis through the actions below.",
    "Do not use your own shell, file, browser, MCP, or computer tools. Jarvis executes actions through its permission gate.",
    'Reply with exactly one JSON object and no markdown: {"text":"user-facing response","toolCalls":[{"name":"action_name","args":{}}]}',
    "Use an empty toolCalls array when no action is needed.",
    "For actions whose result is not needed to answer (for example open_browser or computer_use), include the final response in text so the turn can finish immediately.",
    "When you must inspect an action result before answering, leave text empty; Jarvis will provide the result in the next turn.",
    `Available actions: ${JSON.stringify(tools || [])}`,
  ].join("\n");
}

function textMessages(messages, tools) {
  const out = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      const requested = JSON.stringify(message.toolCalls.map(({ name, args }) => ({ name, args })));
      out.push({
        role: "assistant",
        content: [message.content, `Jarvis action requests: ${requested}`]
          .filter(Boolean)
          .join("\n"),
      });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: `Jarvis action result for ${message.name}: ${
          message.content || JSON.stringify(message.response || {})
        }`,
      });
      continue;
    }
    if (typeof message.content === "string") out.push({ ...message });
  }

  const protocol = protocolPrompt(tools);
  const system = out.find((message) => message.role === "system");
  if (system) system.content = `${system.content}\n\n${protocol}`;
  else out.unshift({ role: "system", content: protocol });
  return out;
}

async function callWithToolsViaChat(chatStream, messages, tools, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TOOL_TIMEOUT_MS);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let raw = "";
  try {
    for await (const chunk of chatStream(textMessages(messages, tools), {
      ...opts,
      signal: controller.signal,
      disableNativeTools: true,
    })) {
      if (chunk && typeof chunk.text === "string") {
        raw += chunk.text;
        if (raw.length >= MAX_RESPONSE_CHARS) break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!raw.trim()) throw new Error("provider returned no tool response");
  return parseToolResponse(raw);
}

module.exports = { callWithToolsViaChat, parseToolResponse, textMessages };
