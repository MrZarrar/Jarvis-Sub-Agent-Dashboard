/**
 * @file providers/ollama.js
 * @description Ollama chat adapter for the multi-provider harness (Phase E,
 * §3.1). Ollama runs on the user's always-on work PC and is reached over the
 * tailnet (default host in config.js; the user points it at the work PC's
 * MagicDNS name in Settings). Models are discovered live from `/api/tags` - the
 * config only stores the host and an optional default model.
 *
 * Uses the built-in `fetch` (Node ≥18); no dependency. NDJSON streaming from
 * Ollama's `/api/chat`.
 *
 * @author Jarvis (Phase E)
 */

const { getProviderConfig } = require("./config");

const CHAT_TIMEOUT_MS = 300_000; // local models can be slow to first token
const TAGS_TIMEOUT_MS = 5_000;

function cfg() {
  return getProviderConfig("ollama");
}

function host() {
  return (cfg().host || "http://localhost:11434").replace(/\/+$/, "");
}

function isConfigured() {
  return Boolean(cfg().enabled && cfg().host);
}

/** Live model list from the Ollama host. Returns [] (never throws) if unreachable. */
async function listModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${host()}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map((m) => (typeof m?.name === "string" ? { id: m.name, label: m.name } : null))
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function* chatStream(messages, opts = {}) {
  const c = cfg();
  const model = opts.model || c.defaultModel;
  if (!model) throw new Error("No Ollama model selected - pick one in the model list");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(`${host()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: (messages || [])
          .filter((m) => m && typeof m.content === "string")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : m.role,
            content: m.content,
          })),
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Ollama request failed (${host()}): ${err.message}`);
  }
  if (!response.ok) {
    clearTimeout(timer);
    const detail = await response.text().catch(() => "");
    throw new Error(`Ollama API ${response.status}: ${detail.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of response.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const text = obj?.message?.content;
        if (typeof text === "string" && text) yield { text };
        if (obj?.done) return;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  id: "ollama",
  label: "Ollama",
  capabilities: { chat: true, image: false },
  isConfigured,
  listModels,
  chatStream,
};
