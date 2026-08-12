/**
 * @file notes.js
 * @description Notes API (Phase G). Notes are markdown files on disk indexed in
 * SQLite (server/lib/notes.js); this router is plain CRUD + search + the
 * brain-dump reformatting flow (Phase G2) + draining the voice/chat "note: …"
 * capture inbox (server/lib/assistant.js writes to assistant_captures). No
 * process-spawning, so it sits behind only the global host/CORS/token guards,
 * same posture as routes/projects.js.
 *
 * Surface:
 *   GET    /api/notes                 - list (?q=&tag=&project=)
 *   GET    /api/notes/tags            - distinct tags with counts
 *   GET    /api/notes/config          - { dir, default }
 *   PUT    /api/notes/config          - set the notes directory
 *   GET    /api/notes/captures        - pending voice/chat capture inbox
 *   POST   /api/notes/dump            - reformat a brain dump (?save to file it)
 *   POST   /api/notes/captures/:id/file    - file a capture as a note
 *   POST   /api/notes/captures/:id/discard - drop a capture
 *   GET    /api/notes/:id             - one note (with body)
 *   POST   /api/notes                 - create
 *   PUT    /api/notes/:id             - update
 *   DELETE /api/notes/:id             - delete
 */

const { Router } = require("express");
const notes = require("../lib/notes");
const { reformatDump } = require("../lib/brain/dump");
const { brainAccess } = require("../lib/brain-lock");
const { db } = require("../db");

const router = Router();

// Capture-inbox statements (assistant_captures is owned by Phase D; we only
// read/drain it here). Prepared once at module load.
const capturesStmts = {
  listInbox: db.prepare(
    "SELECT * FROM assistant_captures WHERE status = 'inbox' ORDER BY created_at DESC LIMIT 200"
  ),
  get: db.prepare("SELECT * FROM assistant_captures WHERE id = ?"),
  setStatus: db.prepare("UPDATE assistant_captures SET status = ? WHERE id = ?"),
};

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}
function notFound(res, message = "note not found") {
  return res.status(404).json({ error: { code: "ENOTFOUND", message } });
}

// ── List / search ────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : null;
  const tag = typeof req.query.tag === "string" ? req.query.tag : null;
  const project = typeof req.query.project === "string" ? req.query.project : null;
  res.json({ items: notes.listNotes({ q, tag, projectId: project, ...brainAccess(req) }) });
});

router.get("/tags", (req, res) => {
  res.json({ items: notes.listTags(brainAccess(req)) });
});

// ── Notes directory config ───────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({ dir: notes.getNotesDir(), default: notes.defaultNotesDir() });
});

router.put("/config", (req, res) => {
  const dir = typeof req.body?.dir === "string" ? req.body.dir : "";
  try {
    const resolved = notes.setNotesDir(dir);
    res.json({ dir: resolved, default: notes.defaultNotesDir() });
  } catch (err) {
    return badRequest(res, "EBADDIR", err.message);
  }
});

// ── Capture inbox (voice/chat "note: …") ─────────────────────────────────
router.get("/captures", (_req, res) => {
  try {
    res.json({ items: capturesStmts.listInbox.all() });
  } catch {
    res.json({ items: [] });
  }
});

router.post("/captures/:id/file", async (req, res) => {
  const cap = safeCapture(req.params.id);
  if (!cap) return notFound(res, "capture not found");
  try {
    const access = brainAccess(req);
    const note = await fileText(
      cap.text,
      cap.source || "voice",
      req.body?.projectId || null,
      req.body?.sensitive === true
    );
    capturesStmts.setStatus.run("filed", cap.id);
    res.status(201).json({ note: visibleCreatedNote(note, access) });
  } catch (err) {
    return res.status(500).json({ error: { code: "EFILE", message: err.message } });
  }
});

router.post("/captures/:id/discard", (req, res) => {
  const cap = safeCapture(req.params.id);
  if (!cap) return notFound(res, "capture not found");
  capturesStmts.setStatus.run("discarded", cap.id);
  res.json({ ok: true });
});

// ── Brain-dump reformatting (Phase G2) ───────────────────────────────────
// POST /dump { text, save?, projectId?, source? }
//   save=false (default) → preview only: { raw, formatted:bool, title, body, tags, todos }
//   save=true            → files it and also returns { note }
router.post("/dump", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return badRequest(res, "EBADINPUT", "text is required");
  const save = req.body?.save === true;
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : null;
  const source = req.body?.source === "voice" ? "voice" : "dump";

  let result;
  try {
    result = await reformatDump(text, { projectHint: projectId });
  } catch (err) {
    return res.status(500).json({ error: { code: "EBRAIN", message: err.message } });
  }

  const payload = {
    raw: text,
    formatted: result.formatted,
    provider: result.provider,
    title: result.title,
    body: result.body,
    tags: result.tags,
    todos: result.todos,
  };

  if (save) {
    try {
      const access = brainAccess(req);
      const note = notes.createNote({
        title: result.title,
        body: result.body,
        tags: result.tags,
        projectId,
        source,
        original: text,
        sensitive: req.body?.sensitive === true,
      });
      payload.note = visibleCreatedNote(note, access);
    } catch (err) {
      return res.status(500).json({ error: { code: "ESAVE", message: err.message } });
    }
    return res.status(201).json(payload);
  }
  res.json(payload);
});

// ── CRUD ──────────────────────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const note = notes.getNote(req.params.id, brainAccess(req));
  if (!note) return notFound(res);
  res.json({ note });
});

router.post("/", (req, res) => {
  const body = req.body || {};
  try {
    const note = notes.createNote({
      title: body.title,
      body: body.body,
      tags: body.tags,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      source: "manual",
      sensitive: body.sensitive === true,
    });
    res.status(201).json({ note: visibleCreatedNote(note, brainAccess(req)) });
  } catch (err) {
    return badRequest(res, "ECREATE", err.message);
  }
});

router.put("/:id", (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.body !== undefined) patch.body = body.body;
  if (body.tags !== undefined) patch.tags = body.tags;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.sensitive !== undefined) patch.sensitive = body.sensitive;
  try {
    const note = notes.updateNote(req.params.id, patch, brainAccess(req));
    if (!note) return notFound(res);
    res.json({ note });
  } catch (err) {
    return badRequest(res, "EUPDATE", err.message);
  }
});

router.delete("/:id", (req, res) => {
  const removed = notes.deleteNote(req.params.id, brainAccess(req));
  if (!removed) return notFound(res);
  res.json({ ok: true });
});

// ── helpers ────────────────────────────────────────────────────────────────
function safeCapture(id) {
  try {
    return capturesStmts.get.get(id) || null;
  } catch {
    return null;
  }
}

/** Reformat raw text and file it as a dump note (used by capture draining). */
async function fileText(text, source, projectId, sensitive = false) {
  const result = await reformatDump(text, { projectHint: projectId });
  return notes.createNote({
    title: result.title,
    body: result.body,
    tags: result.tags,
    projectId,
    source: source === "voice" ? "voice" : "dump",
    original: text,
    sensitive,
  });
}

function visibleCreatedNote(note, { includeSensitive }) {
  return note?.sensitive && !includeSensitive ? null : note;
}

module.exports = router;
