/**
 * @file providers/openai-compat.js
 * @description One OpenAI-compatible chat adapter, instantiated per provider
 * (Phase Q1): DeepSeek (`api.deepseek.com`), NVIDIA NIM
 * (`integrate.api.nvidia.com/v1`), and the real OpenAI API - which finally
 * powers the reserved GPT slot when a key exists. All three speak the same
 * `POST {baseUrl}/chat/completions` SSE dialect, so this is a factory over
 * baseURL + key + model list rather than three copies.
 *
 * Dependency-free (built-in fetch), same interface as every chat provider
 * (see index.js): isConfigured / listModels / chatStream. Vision is
 * deliberately flagged OFF for all three in v1 - image input support varies
 * by model and account tier; be honest rather than silently dropping images.
 *
 * @author Jarvis (Phase Q1)
 */

const { getProviderConfig } = require("./config");
const { callWithToolsViaChat } = require("./cli-tools");

const CHAT_TIMEOUT_MS = 300_000; // free tiers queue; be patient

/** Yield each `data:` JSON object from an OpenAI-style SSE stream. */
async function* sseObjects(response) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        yield JSON.parse(json);
      } catch {
        /* partial line - a later chunk completes it */
      }
    }
  }
}

/**
 * Build one adapter. `id` is both the registry key and the config.js section
 * name; `note` is surfaced in the provider picker (honest rate-limit /
 * data-use caveats belong in the Settings card copy, not here).
 */
function createOpenAICompatProvider({ id, label, note, promptTools = false }) {
  const cfg = () => getProviderConfig(id);

  function isConfigured() {
    const c = cfg();
    return Boolean(c.enabled && c.apiKey);
  }

  function listModels() {
    const c = cfg();
    const models = Array.isArray(c.chatModels) ? c.chatModels : [];
    return models.map((m) => ({ id: m, label: m }));
  }

  async function* chatStream(messages, opts = {}) {
    const c = cfg();
    if (!c.apiKey) throw new Error(`${label} API key is not configured`);
    const baseUrl = String(c.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error(`${label} base URL is not configured`);
    const model = opts.model || c.defaultModel;
    if (!model) throw new Error(`No ${label} model selected`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    if (opts.signal)
      opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: (messages || [])
            .filter((m) => m && typeof m.content === "string")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`${label} request failed: ${err.message}`);
    }
    if (!response.ok) {
      clearTimeout(timer);
      const detail = await response.text().catch(() => "");
      throw new Error(`${label} API ${response.status}: ${detail.slice(0, 300)}`);
    }

    try {
      for await (const obj of sseObjects(response)) {
        const delta = obj?.choices?.[0]?.delta;
        // DeepSeek's reasoner streams reasoning_content before content -
        // surface only the final answer channel, like their own UI default.
        const text = delta?.content;
        if (typeof text === "string" && text) yield { text };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const provider = {
    id,
    label,
    note,
    capabilities: {
      chat: true,
      image: false,
      vision: false,
      ...(promptTools ? { tools: true, promptTools: true } : {}),
    },
    isConfigured,
    listModels,
    chatStream,
  };
  if (promptTools) {
    provider.callWithTools = (messages, tools, opts) =>
      callWithToolsViaChat(chatStream, messages, tools, opts);
  }
  return provider;
}

module.exports = { createOpenAICompatProvider };
