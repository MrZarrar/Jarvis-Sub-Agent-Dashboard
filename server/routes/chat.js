/**
 * @file chat.js
 * @description HTTP routes for the multi-provider Chat page (Phase E, §E1). A
 * `chats` conversation holds ordered `chat_messages`; the assistant reply is
 * produced by the selected provider adapter (server/lib/providers) and streamed
 * to the browser as Server-Sent Events. Image generation (Gemini) saves the
 * bytes under the data dir and returns an assistant message referencing them.
 *
 * All routes are first-party web UI only, so - like the Run router - the whole
 * surface sits behind the loopback same-origin guard (CSRF defense) on top of
 * the global DASHBOARD_TOKEN gate. Provider secrets never leave the server:
 * `GET /config` returns a redacted view.
 *
 * @author Jarvis (Phase E)
 */

const { Router } = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { db, stmts } = require("../db");
const providers = require("../lib/providers");
const { getDataDir } = require("../lib/claude-home");
const { __sameOriginGuard: sameOriginGuard } = require("./run");

const router = Router();
router.use(sameOriginGuard);

const IMAGE_DIR = path.join(getDataDir(), "chat-images");
const IMAGE_NAME_RE = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/;
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}

// ── Providers + config ──────────────────────────────────────────────────────

// Live provider/model picker data for the Chat page and Settings.
router.get("/providers", async (_req, res) => {
  try {
    res.json({ providers: await providers.getProvidersStatus() });
  } catch (err) {
    res.status(500).json({ error: { code: "EINTERNAL", message: err.message } });
  }
});

// Redacted config (secrets replaced by hasApiKey booleans) for the Settings UI.
router.get("/config", (_req, res) => {
  res.json({ config: providers.redactedConfig() });
});

// Update provider config (keys/hosts/models). Body is a partial patch.
router.put("/config", (req, res) => {
  try {
    const config = providers.updateConfig(req.body || {});
    // Never echo the raw config back - return the redacted view.
    void config;
    res.json({ config: providers.redactedConfig() });
  } catch (err) {
    res.status(400).json({ error: { code: "EBADCONFIG", message: err.message } });
  }
});

// ── Chats CRUD ──────────────────────────────────────────────────────────────

router.get("/chats", (req, res) => {
  const limit = Math.min(
    Math.max(Number.parseInt(String(req.query.limit || "50"), 10) || 50, 1),
    200
  );
  const offset = Math.max(Number.parseInt(String(req.query.offset || "0"), 10) || 0, 0);
  res.json({ items: stmts.listChats.all(limit, offset) });
});

router.post("/chats", (req, res) => {
  const body = req.body || {};
  const id = randomUUID();
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
  const provider = typeof body.provider === "string" ? body.provider : null;
  const model = typeof body.model === "string" ? body.model : null;
  // Optional Project tag (Phase F) - chats have no cwd, so this is the only
  // association path; unlike sessions/runs there is no auto-detection.
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
  stmts.insertChat.run({ id, title, provider, model, project_id: projectId });
  res.status(201).json({ chat: stmts.getChat.get(id) });
});

router.get("/chats/:id", (req, res) => {
  const chat = stmts.getChat.get(req.params.id);
  if (!chat)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "chat not found" } });
  res.json({ chat, messages: stmts.listChatMessages.all(req.params.id) });
});

router.patch("/chats/:id", (req, res) => {
  const chat = stmts.getChat.get(req.params.id);
  if (!chat)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "chat not found" } });
  const body = req.body || {};
  // projectId is independent of title: a caller may patch either or both.
  if (typeof body.projectId !== "undefined") {
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
    stmts.setChatProject.run(projectId, req.params.id);
  }
  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 200);
    if (!title) return badRequest(res, "EBADINPUT", "title is required");
    stmts.renameChat.run(title, req.params.id);
  }
  res.json({ chat: stmts.getChat.get(req.params.id) });
});

router.delete("/chats/:id", (req, res) => {
  const changes = stmts.deleteChat.run(req.params.id).changes;
  if (!changes)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "chat not found" } });
  res.json({ ok: true });
});

// ── Streaming completion (SSE) ──────────────────────────────────────────────

router.post("/chats/:id/messages", async (req, res) => {
  const chat = stmts.getChat.get(req.params.id);
  if (!chat)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "chat not found" } });

  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text : "";
  const providerId = typeof body.provider === "string" ? body.provider : chat.provider;
  const model = typeof body.model === "string" && body.model ? body.model : chat.model || null;
  if (!text.trim()) return badRequest(res, "EBADINPUT", "text is required");

  const adapter = providers.getChatProvider(providerId);
  if (!adapter)
    return badRequest(res, "EBADPROVIDER", `unknown or unavailable provider: ${providerId}`);

  // Persist the user turn, then assemble the full transcript for the model.
  const userMsg = {
    id: randomUUID(),
    chat_id: chat.id,
    role: "user",
    provider: providerId,
    model,
    content: text,
    image_path: null,
  };
  stmts.insertChatMessage.run(userMsg);
  stmts.touchChat.run(providerId, model, null, chat.id);

  const history = stmts.listChatMessages
    .all(chat.id)
    .filter((m) => m.role !== "system" || m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  // SSE - set headers up front; from here on all outcomes are SSE events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("user", userMsg);

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let full = "";
  let newSessionId = null;
  try {
    const opts = { model, signal: controller.signal };
    if (providerId === "claude" && chat.cc_session_id) opts.resumeSessionId = chat.cc_session_id;
    for await (const chunk of adapter.chatStream(history, opts)) {
      if (chunk?.meta?.sessionId) {
        newSessionId = chunk.meta.sessionId;
        continue;
      }
      if (typeof chunk?.text === "string" && chunk.text) {
        full += chunk.text;
        send("delta", { text: chunk.text });
      }
    }
  } catch (err) {
    // Still persist any partial text so the transcript isn't lost.
    if (full) persistAssistant(chat.id, providerId, model, full, null);
    if (newSessionId) stmts.touchChat.run(null, null, newSessionId, chat.id);
    send("error", { message: err.message });
    return res.end();
  }

  const assistantMsg = persistAssistant(chat.id, providerId, model, full, null);
  if (newSessionId) stmts.touchChat.run(null, null, newSessionId, chat.id);
  maybeAutoTitle(chat, text);
  send("done", { message: assistantMsg });
  res.end();
});

function persistAssistant(chatId, provider, model, content, imagePath) {
  const msg = {
    id: randomUUID(),
    chat_id: chatId,
    role: "assistant",
    provider,
    model,
    content: content || "",
    image_path: imagePath,
  };
  stmts.insertChatMessage.run(msg);
  return msg;
}

// First user turn seeds a title if the chat is still untitled.
function maybeAutoTitle(chat, firstUserText) {
  if (chat.title) return;
  const title = firstUserText.replace(/\s+/g, " ").trim().slice(0, 60);
  if (title) stmts.renameChat.run(title, chat.id);
}

// ── Image generation (Gemini) ───────────────────────────────────────────────

router.post("/chats/:id/image", async (req, res) => {
  const chat = stmts.getChat.get(req.params.id);
  if (!chat)
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "chat not found" } });
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (!prompt.trim()) return badRequest(res, "EBADINPUT", "prompt is required");

  const adapter = providers.getChatProvider("gemini");
  if (!adapter || typeof adapter.generateImage !== "function") {
    return badRequest(res, "ENOIMAGE", "image generation is not available for this provider");
  }

  // Record the prompt as a user message so the transcript reads naturally.
  stmts.insertChatMessage.run({
    id: randomUUID(),
    chat_id: chat.id,
    role: "user",
    provider: "gemini",
    model: req.body?.model || null,
    content: prompt,
    image_path: null,
  });

  try {
    const { mimeType, base64 } = await adapter.generateImage(prompt, { model: req.body?.model });
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const ext = EXT_BY_MIME[mimeType] || "png";
    const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, file), Buffer.from(base64, "base64"));
    const msg = persistAssistant(chat.id, "gemini", req.body?.model || null, "", file);
    maybeAutoTitle(chat, prompt);
    stmts.touchChat.run("gemini", req.body?.model || null, null, chat.id);
    res.status(201).json({ message: msg, url: `/api/chat/images/${file}` });
  } catch (err) {
    res.status(502).json({ error: { code: "EIMAGE", message: err.message } });
  }
});

// Serve a generated image. Filename is validated against a strict pattern so a
// crafted `..` can never escape the image dir.
router.get("/images/:file", (req, res) => {
  const file = req.params.file;
  if (!IMAGE_NAME_RE.test(file))
    return res.status(400).json({ error: { code: "EBADNAME", message: "bad filename" } });
  const abs = path.join(IMAGE_DIR, file);
  if (!abs.startsWith(IMAGE_DIR + path.sep))
    return res.status(400).json({ error: { code: "EBADNAME", message: "bad filename" } });
  if (!fs.existsSync(abs))
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "image not found" } });
  res.sendFile(abs);
});

module.exports = router;
