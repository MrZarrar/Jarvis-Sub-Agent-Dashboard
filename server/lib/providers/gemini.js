/**
 * @file providers/gemini.js
 * @description Gemini chat + image adapter for the multi-provider harness
 * (Phase E, §3.1). Talks to the Google Generative Language REST API directly
 * over the built-in `fetch` (Node ≥18) - deliberately dependency-free rather
 * than pulling in `@google/genai`, so a fresh checkout needs no extra install
 * and the SDK can be swapped behind this same interface later if wanted. The
 * key never leaves the server (config.js).
 *
 * Interface (shared by every chat provider - see index.js):
 *   isConfigured()            → bool
 *   listModels()              → [{ id, label }]
 *   async *chatStream(msgs, opts) → yields { text } deltas
 *   generateImage(prompt,opts) → { mimeType, base64 }   (Gemini-only capability)
 *
 * @author Jarvis (Phase E)
 */

const { getProviderConfig } = require("./config");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CHAT_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 120_000;

function cfg() {
  return getProviderConfig("gemini");
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.enabled && c.apiKey);
}

function listModels() {
  const c = cfg();
  const models = Array.isArray(c.chatModels) ? c.chatModels : [];
  return models.map((id) => ({ id, label: id }));
}

/** Map the harness's role/content messages onto Gemini's contents + system. */
function toGeminiPayload(messages) {
  const contents = [];
  let systemInstruction = null;
  for (const m of messages || []) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  return body;
}

/** Yield each `data:` payload object from a Gemini SSE (`alt=sse`) response body. */
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
        /* partial/interleaved JSON - skip; a later line completes it */
      }
    }
  }
}

async function* chatStream(messages, opts = {}) {
  const c = cfg();
  if (!c.apiKey) throw new Error("Gemini API key is not configured");
  const model = opts.model || c.defaultModel || "gemini-3.5-flash";
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": c.apiKey },
      body: JSON.stringify(toGeminiPayload(messages)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Gemini request failed: ${err.message}`);
  }
  if (!response.ok) {
    clearTimeout(timer);
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 300)}`);
  }
  try {
    for await (const obj of sseObjects(response)) {
      const parts = obj?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (typeof p?.text === "string" && p.text) yield { text: p.text };
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Map the harness's messages (incl. tool-call / tool-result turns) onto Gemini
 *  `contents`, for the function-calling path. */
function toGeminiToolContents(messages) {
  const contents = [];
  let systemInstruction = null;
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "system" && typeof m.content === "string") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const parts = m.toolCalls.map((c) => ({
        functionCall: { name: c.name, args: c.args || {} },
      }));
      if (typeof m.content === "string" && m.content.trim()) parts.unshift({ text: m.content });
      contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      // functionResponse turns use role "user" in the v1beta REST shape.
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name, response: m.response || {} } }],
      });
      continue;
    }
    if (typeof m.content === "string") {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  return body;
}

/**
 * One non-streaming function-calling round (Phase M, §3.1). Sends the registry's
 * tool specs as Gemini `functionDeclarations`; returns any text plus the tool
 * calls the model wants to make. The agent loop (assistant-actions) dispatches
 * those through the gate and calls back for the next round.
 * @returns {Promise<{text, toolCalls:[{name,args}]}>}
 */
async function callWithTools(messages, tools = [], opts = {}) {
  const c = cfg();
  if (!c.apiKey) throw new Error("Gemini API key is not configured");
  const model = opts.model || c.defaultModel || "gemini-3.5-flash";
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const body = toGeminiToolContents(messages);
  if (Array.isArray(tools) && tools.length) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": c.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Gemini request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let text = "";
  const toolCalls = [];
  for (const p of parts) {
    if (typeof p?.text === "string") text += p.text;
    if (p?.functionCall && typeof p.functionCall.name === "string") {
      toolCalls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
    }
  }
  return { text: text.trim(), toolCalls };
}

/**
 * Generate an image. Returns the first inline image part as base64. Throws with
 * an honest message if the configured image model returns no image (e.g. the
 * model id drifted or the plan lacks image quota - see §E1 step 2).
 */
async function generateImage(prompt, opts = {}) {
  const c = cfg();
  if (!c.apiKey) throw new Error("Gemini API key is not configured");
  const model = opts.model || c.imageModel;
  if (!model) throw new Error("No Gemini image model configured");
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": c.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Gemini image request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini image API ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p?.inlineData?.data) {
      return { mimeType: p.inlineData.mimeType || "image/png", base64: p.inlineData.data };
    }
  }
  throw new Error("Gemini returned no image - check the configured image model id and quota");
}

module.exports = {
  id: "gemini",
  label: "Gemini",
  capabilities: { chat: true, image: true, tools: true },
  isConfigured,
  listModels,
  chatStream,
  callWithTools,
  generateImage,
};
