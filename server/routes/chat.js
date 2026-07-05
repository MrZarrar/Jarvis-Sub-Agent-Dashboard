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

// ── Uploads (Phase Q1) ──────────────────────────────────────────────────────
// User attachments (images + small text files) live alongside the Phase-E
// generated images under the data dir. Stored names are server-generated
// (never the client's), so the serve route's strict pattern is airtight.
const UPLOAD_DIR = path.join(getDataDir(), "chat-uploads");
const UPLOAD_NAME_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_MAX_BYTES = 256 * 1024;
// Per-file cap when inlining a text attachment into the prompt; keeps one log
// file from eating the whole context window.
const TEXT_INLINE_CAP = 24 * 1024;

/** Text-ish uploads: code, logs, markdown, json, csv… anything renderable. */
function isTextMime(mime, name) {
  if (typeof mime === "string" && (mime.startsWith("text/") || mime === "application/json"))
    return true;
  return /\.(md|txt|log|json|csv|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|sh|sql)$/i.test(
    name || ""
  );
}

const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 1 },
});

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}

/** Parse a message row's attachments JSON. Never throws. */
function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Row → client shape (attachments as an array, not a JSON string). */
function publicMessage(row) {
  return { ...row, attachments: parseAttachments(row.attachments) };
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

// ── Upload (Phase Q1) ───────────────────────────────────────────────────────

// One file per request (the client uploads a multi-select sequentially).
// Images ≤8MB (png/jpeg/webp/gif), text-ish files ≤256KB. Returns the stored
// descriptor the client passes back in the message's `attachments` array.
router.post("/upload", upload.single("file"), (req, res) => {
  const f = req.file;
  if (!f) return badRequest(res, "EBADINPUT", "file is required (multipart field: file)");
  const original = String(f.originalname || "file").slice(0, 120);
  const isImage = IMAGE_MIME.has(f.mimetype);
  const isText = !isImage && isTextMime(f.mimetype, original);
  if (!isImage && !isText) {
    return badRequest(
      res,
      "EBADTYPE",
      "only images (png/jpeg/webp/gif) and text files are allowed"
    );
  }
  if (isText && f.size > TEXT_MAX_BYTES) {
    return badRequest(res, "ETOOBIG", `text files are capped at ${TEXT_MAX_BYTES / 1024}KB`);
  }
  const ext = isImage
    ? EXT_BY_MIME[f.mimetype]
    : (original.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "txt").toLowerCase();
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, file), f.buffer);
  res.status(201).json({
    attachment: {
      file,
      name: original,
      mimeType: f.mimetype || (isText ? "text/plain" : "application/octet-stream"),
      size: f.size,
      kind: isImage ? "image" : "text",
      url: `/api/chat/uploads/${file}`,
    },
  });
});

// Serve an uploaded attachment. Same strict-name discipline as /images/:file.
router.get("/uploads/:file", (req, res) => {
  const file = req.params.file;
  if (!UPLOAD_NAME_RE.test(file))
    return res.status(400).json({ error: { code: "EBADNAME", message: "bad filename" } });
  const abs = path.join(UPLOAD_DIR, file);
  if (!abs.startsWith(UPLOAD_DIR + path.sep))
    return res.status(400).json({ error: { code: "EBADNAME", message: "bad filename" } });
  if (!fs.existsSync(abs))
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "file not found" } });
  res.sendFile(abs);
});

// ── Link preview (Phase Q2) ─────────────────────────────────────────────────

// OpenGraph card for a URL in a chat message. SSRF-guarded server-side fetch
// (public addresses only, every redirect re-validated) - see lib/link-preview.
router.get("/link-preview", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) return badRequest(res, "EBADINPUT", "url is required");
  try {
    const preview = await require("../lib/link-preview").fetchLinkPreview(url);
    res.json({ preview });
  } catch (err) {
    res.status(502).json({ error: { code: "EPREVIEW", message: err.message } });
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
  res.json({ chat, messages: stmts.listChatMessages.all(req.params.id).map(publicMessage) });
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
  const attachments = sanitizeIncomingAttachments(body.attachments);
  if (!text.trim() && attachments.length === 0)
    return badRequest(res, "EBADINPUT", "text is required");

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
    attachments: attachments.length ? JSON.stringify(attachments) : null,
  };
  stmts.insertChatMessage.run(userMsg);
  stmts.touchChat.run(providerId, model, null, chat.id);

  const vision = Boolean(adapter.capabilities && adapter.capabilities.vision);
  const history = stmts.listChatMessages
    .all(chat.id)
    .filter((m) => m.role !== "system" || m.content)
    .map((m) => historyMessage(m, vision));

  // SSE - set headers up front; from here on all outcomes are SSE events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("user", publicMessage(userMsg));

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
    attachments: null,
  };
  stmts.insertChatMessage.run(msg);
  return msg;
}

/**
 * Accept only attachments the upload route actually produced: stored-name
 * pattern + the file must exist under UPLOAD_DIR. Anything else is dropped -
 * a crafted `file` can never reference an arbitrary path.
 */
function sanitizeIncomingAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a.file !== "string" || !UPLOAD_NAME_RE.test(a.file)) continue;
    const abs = path.join(UPLOAD_DIR, a.file);
    if (!fs.existsSync(abs)) continue;
    out.push({
      file: a.file,
      name: typeof a.name === "string" ? a.name.slice(0, 120) : a.file,
      mimeType: typeof a.mimeType === "string" ? a.mimeType.slice(0, 80) : "",
      size: Number(a.size) || 0,
      kind: a.kind === "image" ? "image" : "text",
    });
  }
  return out;
}

/**
 * One transcript row → provider message (Phase Q1). Text attachments inline
 * into the content (capped) for EVERY provider; image attachments become
 * base64 `images` only for vision-capable providers - others get an honest
 * bracketed note instead of a silently-dropped image.
 */
function historyMessage(row, vision) {
  const atts = parseAttachments(row.attachments);
  let content = row.content || "";
  const images = [];
  for (const a of atts) {
    const abs = path.join(UPLOAD_DIR, String(a.file || ""));
    if (!UPLOAD_NAME_RE.test(String(a.file || "")) || !fs.existsSync(abs)) continue;
    if (a.kind === "image") {
      if (vision) {
        try {
          images.push({
            mimeType: a.mimeType || "image/png",
            base64: fs.readFileSync(abs).toString("base64"),
          });
        } catch {
          /* unreadable - skip */
        }
      } else {
        content += `\n\n[Image attached: ${a.name} - not visible to this provider]`;
      }
    } else {
      try {
        let body = fs.readFileSync(abs, "utf8");
        if (body.length > TEXT_INLINE_CAP)
          body = body.slice(0, TEXT_INLINE_CAP) + "\n… [truncated]";
        content += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${body}\n\`\`\``;
      } catch {
        /* unreadable - skip */
      }
    }
  }
  const msg = { role: row.role, content };
  if (images.length) msg.images = images;
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
    attachments: null,
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

// Multer errors (oversized file, wrong field) → a clean 400, not a 500 page.
router.use((err, _req, res, next) => {
  if (err && err.name === "MulterError") {
    return badRequest(res, "EUPLOAD", err.message);
  }
  next(err);
});

module.exports = router;
