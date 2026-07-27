/**
 * @file vault.js
 * @description Knowledge vault (Phase S). The vault IS the notes tree - markdown
 * files on disk stay the system of record (Obsidian-compatible); this module adds
 * the GRAPH over them: a rebuildable `vault_edges` index of wikilinks (`[[...]]`)
 * and frontmatter relations, PARA-style folders, guardrailed agent writes (only
 * `inbox/` or `agent/`, always a fresh file, never overwriting human notes), and
 * the v1 auto-population writers (run summaries opt-in per project, chat saves).
 *
 * Edge indexing rides the existing notes pipeline via notes.setVaultHooks - one
 * watcher, one debounce, one `note_changed` WS event. A node's `type` is derived
 * from its top-level folder (no schema addition); unresolved wikilinks keep their
 * `dst_key` and resolve the moment the target file appears.
 *
 * @author Jarvis (Phase S)
 */

const fs = require("node:fs");
const path = require("node:path");
const { db, stmts } = require("../db");
const notes = require("./notes");

const SUMMARY_PROJECTS_KEY = "vault_summary_projects";

// PARA-style structure (locked with the user in PLAN-jarvis-vault.md).
const FOLDERS = [
  "inbox",
  "projects",
  "people",
  "reference",
  "daily",
  "agent",
  path.join("agent", "runs"),
  path.join("agent", "chats"),
];

// Agent/dashboard writers may only create files under these subtrees.
const WRITABLE = ["inbox", "agent"];
// The entity engine (Phase T, source: "engine") additionally promotes entities
// into these subtrees; no other writer may touch them.
const ENGINE_WRITABLE = ["people", "reference"];

const TYPE_BY_FOLDER = {
  inbox: "capture",
  projects: "project",
  people: "person",
  reference: "reference",
  daily: "daily",
  agent: "agent",
};
const NOTE_ALIASES_CACHE = new Map();

// ── Setup ────────────────────────────────────────────────────────────────────

function ensureVaultFolders() {
  const dir = notes.ensureNotesDir();
  for (const f of FOLDERS) {
    try {
      fs.mkdirSync(path.join(dir, f), { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  return dir;
}

/** Register the edge-index hooks and scaffold folders. Call BEFORE
 *  notes.startNotesWatcher so the boot reindex builds edges too. */
function init() {
  ensureVaultFolders();
  notes.setVaultHooks({ indexed: onIndexed, removed: onRemoved });
}

// ── Node type (derived from the path, never stored) ─────────────────────────

function nodeType(absPath) {
  const dir = notes.getNotesDir();
  const rel = path.relative(dir, absPath);
  if (rel.startsWith("..")) return "note";
  const parts = rel.split(path.sep);
  if (parts.length < 2) return "note"; // file at the vault root
  if (parts[0] === "agent" && parts.length > 2) {
    if (parts[1] === "runs") return "run";
    if (parts[1] === "chats") return "chat";
  }
  return TYPE_BY_FOLDER[parts[0]] || "note";
}

// ── Wikilink parsing + edge index (rides the notes index hooks) ──────────────

/** `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` → unique normalized
 *  keys. Embeds (`![[...]]`) count as links too - they reference the target. */
function parseWikilinks(body) {
  const keys = new Set();
  const re = /\[\[([^\][|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    const key = normalizeKey(m[1]);
    if (key) keys.add(key);
  }
  return [...keys];
}

// Keys fold whitespace/underscores to hyphens so `[[Jarvis Project]]` resolves
// to `jarvis-project.md` (slugged filenames) as well as a "Jarvis Project" title.
function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s_]+/g, "-");
}

/** Frontmatter aliases a note answers to as a link target. */
function noteAliases(row) {
  const cacheKey = `${row.path}:${row.mtime || ""}`;
  if (NOTE_ALIASES_CACHE.has(cacheKey)) return NOTE_ALIASES_CACHE.get(cacheKey);
  try {
    const aliases = notes.parseFrontmatter(fs.readFileSync(row.path, "utf8")).meta.aliases;
    const out = Array.isArray(aliases) ? aliases.map(String).filter(Boolean) : [];
    NOTE_ALIASES_CACHE.set(cacheKey, out);
    return out;
  } catch {
    return [];
  }
}

/** Keys a note answers to: title, filename, and Obsidian aliases. */
function keysFor(row) {
  const out = new Set();
  const t = normalizeKey(row.title);
  if (t) out.add(t);
  const base = normalizeKey(path.basename(row.path));
  if (base) out.add(base);
  for (const alias of noteAliases(row)) {
    const key = normalizeKey(alias);
    if (key) out.add(key);
  }
  return [...out];
}

const projectStubStmt = db.prepare(
  "SELECT id FROM notes WHERE project_id = ? AND path LIKE ? ORDER BY updated_at DESC LIMIT 1"
);

/** Resolve a wikilink key → note id. Both titles and file basenames answer,
 *  normalized the same way as the key; ties go to the most recently updated
 *  note (listNotes orders by updated_at DESC).
 *  ponytail: linear scan per link - index a normalized-key column if vaults
 *  ever reach tens of thousands of notes. */
function resolveKey(key) {
  try {
    const matches = stmts.listNotes.all().filter((r) => keysFor(r).includes(key));
    // Human-authored notes beat disposable engine stubs. Between duplicate
    // stubs, keep the original filename rather than a later `-2.md` copy.
    matches.sort((a, b) => {
      const human = Number(a.source === "engine") - Number(b.source === "engine");
      if (human) return human;
      const placeholder =
        Number(/^Auto created by the vault engine/i.test(a.excerpt || "")) -
        Number(/^Auto created by the vault engine/i.test(b.excerpt || ""));
      if (placeholder) return placeholder;
      const suffixed = Number(/-\d+\.md$/i.test(a.path)) - Number(/-\d+\.md$/i.test(b.path));
      return suffixed || String(a.created_at || "").localeCompare(String(b.created_at || ""));
    });
    return matches[0]?.id || null;
  } catch {
    /* unresolved */
  }
  return null;
}

const edgeTx = db.transaction((row, body, meta) => {
  stmts.deleteVaultEdgesFrom.run(row.id);
  for (const key of parseWikilinks(body)) {
    const dstId = resolveKey(key);
    stmts.insertVaultEdge.run({
      src_id: row.id,
      dst_key: key,
      dst_id: dstId === row.id ? null : dstId,
      type: "link",
    });
  }
  // Frontmatter `project:` → edge to the project's stub file (if one exists).
  const pid = row.project_id;
  if (pid) {
    const stub = findProjectStub(pid);
    if (stub && stub !== row.id) {
      stmts.insertVaultEdge.run({
        src_id: row.id,
        dst_key: `project:${pid}`,
        dst_id: stub,
        type: "project",
      });
    }
  }
  // This file may be the target other notes were waiting for.
  for (const key of keysFor(row)) {
    stmts.resolveVaultEdges.run(row.id, key);
  }
  if (meta && meta.project === undefined) {
    /* no-op: meta reserved for future typed relations */
  }
});

function onIndexed(row, body, meta) {
  try {
    edgeTx(row, body, meta);
  } catch {
    /* fail-safe: a bad edge pass never breaks the note index */
  }
}

function onRemoved(id) {
  try {
    stmts.deleteVaultEdgesFrom.run(id);
    stmts.unresolveVaultEdges.run(id);
    // Entity engine (Phase T) bookkeeping: a deleted note stops counting as a
    // mention, and an entity whose promoted file was deleted un-promotes (it
    // can earn its node back on future mentions).
    stmts.deleteVaultMentionsForNote.run(id);
    stmts.deleteVaultEntityFactsForNote.run(id);
    stmts.clearVaultEntityNote.run(id);
  } catch {
    /* fail-safe */
  }
}

function findProjectStub(projectId) {
  try {
    const dir = notes.getNotesDir();
    const row = projectStubStmt.get(projectId, `${path.join(dir, "projects")}${path.sep}%`);
    return row ? row.id : null;
  } catch {
    return null;
  }
}

// ── Graph queries ────────────────────────────────────────────────────────────

function graph() {
  let rows = [];
  try {
    rows = stmts.listNotes.all();
  } catch {
    rows = [];
  }
  const nodes = rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: nodeType(r.path),
    tags: safeTags(r.tags),
    projectId: r.project_id || null,
    updatedAt: r.updated_at,
  }));
  const known = new Set(nodes.map((n) => n.id));
  let edges = [];
  try {
    edges = stmts.listVaultEdges
      .all()
      .filter((e) => e.src_id !== e.dst_id && known.has(e.src_id) && known.has(e.dst_id))
      .map((e) => ({ src: e.src_id, dst: e.dst_id, type: e.type }));
  } catch {
    edges = [];
  }
  return { nodes, edges };
}

/** One node with body, outgoing links (resolved + unresolved) and backlinks. */
function node(id) {
  const note = notes.getNote(id);
  if (!note) return null;
  const outgoing = [];
  const backlinks = [];
  try {
    for (const e of stmts.vaultEdgesFrom.all(id)) {
      const dst = e.dst_id ? notes.getNote(e.dst_id) : null;
      outgoing.push({
        key: e.dst_key,
        type: e.type,
        id: e.dst_id,
        title: dst ? dst.title : null,
        resolved: !!e.dst_id,
      });
    }
    for (const e of stmts.vaultEdgesTo.all(id)) {
      const src = notes.getNote(e.src_id);
      if (src) backlinks.push({ id: src.id, title: src.title, type: e.type });
    }
  } catch {
    /* partial is fine */
  }
  return { ...note, nodeType: nodeType(note.path), outgoing, backlinks };
}

/** Shortest path between two nodes over the (undirected) resolved edge set. */
function pathBetween(fromId, toId) {
  if (fromId === toId) return [fromId];
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  try {
    for (const e of stmts.listVaultEdges.all()) {
      add(e.src_id, e.dst_id);
      add(e.dst_id, e.src_id);
    }
  } catch {
    return null;
  }
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === toId) {
        const out = [toId];
        let p = cur;
        while (p !== null) {
          out.unshift(p);
          p = prev.get(p);
        }
        return out;
      }
      queue.push(next);
    }
  }
  return null;
}

// ── Guardrailed vault writes (agents + dashboard writers) ────────────────────

/** Write a NEW markdown file under an allowed folder and index it immediately.
 *  Never overwrites: the path is always made unique. Returns the API note. */
function writeVaultFile({
  folder = "inbox",
  title,
  body = "",
  tags = [],
  projectId = null,
  source = "agent",
  extraMeta = {},
}) {
  const clean = String(folder || "inbox")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const top = clean.split("/")[0];
  const allowed = source === "engine" ? [...WRITABLE, ...ENGINE_WRITABLE] : WRITABLE;
  if (!allowed.includes(top)) {
    const err = new Error(`vault writes are limited to: ${allowed.join(", ")}/`);
    err.code = "EACCES";
    throw err;
  }
  if (clean.split("/").some((p) => p === "." || p === "..")) {
    const err = new Error("invalid vault folder");
    err.code = "EACCES";
    throw err;
  }
  const dir = path.join(ensureVaultFolders(), ...clean.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const { randomUUID } = require("node:crypto");
  const id = randomUUID();
  const now = new Date().toISOString();
  const meta = {
    id,
    title: title || "Untitled",
    tags: Array.isArray(tags) ? tags : [],
    project: projectId || "",
    created: now,
    updated: now,
    source,
    ...extraMeta,
  };
  const slugBase =
    String(title || "note")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note";
  let file = path.join(dir, `${slugBase}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${slugBase}-${n++}.md`);
  fs.writeFileSync(file, `${notes.serializeFrontmatter(meta)}\n\n${String(body).trim()}\n`, "utf8");
  const row = notes.indexFile(file);
  return notes.toApiNote(row, body);
}

// ── Durable facts on a node (conversational capture) ─────────────────────────
// Append a fact bullet to an EXISTING node inside an engine-owned block, so
// "Volkan's fav word is actually" lands ON volkan.md and a later "fav color?"
// is one cheap read of the node. Mirrors the vault-engine links block: raw-text
// swap (human prose untouched), idempotent on duplicate facts. Sits directly
// above the jarvis:links block when present so the engine's link regex is never
// disturbed.
const FACTS_BLOCK_RE = /[ \t]*<!-- jarvis:facts -->[\s\S]*?<!-- \/jarvis:facts -->/;
const LINKS_BLOCK_RE = /[ \t]*<!-- jarvis:links -->[\s\S]*?<!-- \/jarvis:links -->/;
const DOB_HINT_RE = /\b(?:born|birth(?:day)?|date of birth|dob|bday)\b/i;
const MONTHS = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function normalizeDateOfBirth(value) {
  let fact = String(value || "");
  if (!DOB_HINT_RE.test(fact)) return fact;
  const pad = (day) => String(day).padStart(2, "0");
  fact = fact.replace(
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (_m, year, month, day) => `${day}/${month}/${year}`
  );
  fact = fact.replace(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+(\d{4})\b/gi,
    (_m, day, month, year) => `${pad(day)}/${MONTHS[month.slice(0, 3).toLowerCase()]}/${year}`
  );
  return fact.replace(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
    (_m, month, day, year) => `${pad(day)}/${MONTHS[month.slice(0, 3).toLowerCase()]}/${year}`
  );
}

function appendFact(nodeId, fact) {
  const clean = normalizeDateOfBirth(fact)
    .trim()
    .replace(/^[-*]\s*/, "");
  if (!clean) {
    const err = new Error("empty fact");
    err.code = "EINVAL";
    throw err;
  }
  const note = notes.getNote(nodeId);
  if (!note) {
    const err = new Error("vault node not found");
    err.code = "ENOTFOUND";
    throw err;
  }
  let raw;
  try {
    raw = fs.readFileSync(note.path, "utf8");
  } catch {
    const err = new Error("could not read vault node");
    err.code = "EIO";
    throw err;
  }
  const m = raw.match(FACTS_BLOCK_RE);
  const lines = m
    ? m[0]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
    : [];
  const bullet = `- ${clean}`;
  if (lines.some((l) => l.toLowerCase() === bullet.toLowerCase())) {
    return { id: note.id, path: note.path, added: false };
  }
  lines.push(bullet);
  const block = `<!-- jarvis:facts -->\n${lines.join("\n")}\n<!-- /jarvis:facts -->`;

  let next;
  if (m) {
    next = raw.replace(FACTS_BLOCK_RE, block);
  } else if (LINKS_BLOCK_RE.test(raw)) {
    next = raw.replace(LINKS_BLOCK_RE, (lm) => `${block}\n${lm.replace(/^[ \t]*/, "")}`);
  } else {
    next = `${raw.replace(/\s*$/, "")}\n\n${block}\n`;
  }
  fs.writeFileSync(note.path, next, "utf8");
  notes.indexFile(note.path); // immediate - don't wait for the watcher debounce
  return { id: note.id, path: note.path, added: true };
}

// ── Run-summary opt-in + writers (S2) ────────────────────────────────────────

function getSummaryProjects() {
  try {
    const row = stmts.getSetting.get(SUMMARY_PROJECTS_KEY);
    const arr = row ? JSON.parse(row.value) : [];
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string" && v) : [];
  } catch {
    return [];
  }
}

function setSummaryProjects(ids) {
  const clean = Array.isArray(ids)
    ? [...new Set(ids.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))]
    : [];
  stmts.setSetting.run(SUMMARY_PROJECTS_KEY, JSON.stringify(clean));
  // Materialize a stub page per opted-in project so summaries have a hub node.
  for (const pid of clean) ensureProjectStub(pid);
  return clean;
}

/** `projects/<name>.md` stub for a dashboard project - the hub its run
 *  summaries wikilink to. Created once; humans own it afterwards. */
function ensureProjectStub(projectId) {
  const existing = findProjectStub(projectId);
  if (existing) return existing;
  let proj = null;
  try {
    proj = stmts.getProject.get(projectId) || null;
  } catch {
    proj = null;
  }
  const name = (proj && proj.name) || projectId;
  const dir = path.join(ensureVaultFolders(), "projects");
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project";
  let file = path.join(dir, `${slug}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${slug}-${n++}.md`);
  const { randomUUID } = require("node:crypto");
  const now = new Date().toISOString();
  const meta = {
    id: randomUUID(),
    title: name,
    tags: ["project"],
    project: projectId,
    created: now,
    updated: now,
    source: "agent",
  };
  const body = (proj && proj.description) || "";
  fs.writeFileSync(file, `${notes.serializeFrontmatter(meta)}\n\n${body}\n`, "utf8");
  const row = notes.indexFile(file);
  return row ? row.id : null;
}

/** Map a finished run to a dashboard project: explicit projectId first, else
 *  its cwd against project_paths. */
function projectForRun(run) {
  if (run && run.projectId) return run.projectId;
  const cwd = run && run.cwd;
  if (!cwd) return null;
  try {
    for (const p of stmts.listAllProjectPaths.all()) {
      if (!p.repo_path) continue;
      if (cwd === p.repo_path || cwd.startsWith(p.repo_path + path.sep)) return p.project_id;
    }
  } catch {
    /* no mapping */
  }
  return null;
}

/** Pull a summarizable text tail out of a run's buffered envelopes. */
function runOutputTail(run, maxChars = 6000) {
  const parts = [];
  for (const env of run.envelopes || []) {
    if (env && env.type === "result" && typeof env.result === "string") {
      parts.push(env.result);
    } else if (
      env &&
      env.type === "assistant" &&
      env.message &&
      Array.isArray(env.message.content)
    ) {
      for (const c of env.message.content) {
        if (c && c.type === "text" && c.text) parts.push(c.text);
      }
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/** Subscribe to run terminal statuses and write `agent/runs/` summary notes for
 *  opted-in projects. Fail-safe end to end: nothing here can break teardown. */
function attachRunSummaryWriter({ runSpawner, brain } = {}) {
  const spawner = runSpawner || require("./run-spawner");
  const router = brain || require("./brain/router");
  spawner.onRunStatus((payload) => {
    // Fire-and-forget; onRunStatus callers are synchronous.
    summarizeRun(payload, spawner, router).catch((err) => {
      console.warn("[vault] run summary failed:", err?.message || err);
    });
  });
}

async function summarizeRun(payload, spawner, router) {
  if (!payload || (payload.status !== "completed" && payload.status !== "error")) return;
  const run = spawner.getRun(payload.id, { includeEnvelopes: true });
  if (!run) return;
  const projectId = projectForRun(run);
  if (!projectId || !getSummaryProjects().includes(projectId)) return;

  const stubId = ensureProjectStub(projectId);
  const stub = stubId ? notes.getNote(stubId) : null;
  const projectTitle = stub ? stub.title : projectId;

  const durationMin =
    run.endedAt && run.startedAt ? Math.round((run.endedAt - run.startedAt) / 60000) : null;
  const facts = [
    `Status: ${run.status}${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}`,
    durationMin != null ? `Duration: ~${durationMin}m` : null,
    `Cwd: ${run.cwd}`,
    run.model ? `Model: ${run.model}` : null,
  ].filter(Boolean);

  let summary;
  try {
    const res = await router.complete({
      taskClass: "standard",
      intent: "vault_summary",
      system:
        "You summarize a finished coding-agent run for a personal knowledge vault. " +
        "Write 3-8 tight markdown bullet points: what was attempted, what changed, the outcome, " +
        "and any follow-ups. Facts only - never invent results.",
      prompt: `Prompt given to the agent:\n${run.prompt || "(unknown)"}\n\nRun facts:\n${facts.join(
        "\n"
      )}\n\nAgent output (tail):\n${runOutputTail(run) || "(no captured output)"}`,
    });
    summary = res.text;
  } catch {
    // Brain down → still record the run factually rather than dropping memory.
    summary = facts.map((f) => `- ${f}`).join("\n");
  }

  const date = new Date().toISOString().slice(0, 10);
  const promptLine = String(run.prompt || "run")
    .split(/\r?\n/)[0]
    .slice(0, 50);
  writeVaultFile({
    folder: "agent/runs",
    title: `${date} ${promptLine}`,
    body: `${summary}\n\n[[${projectTitle}]]\n`,
    tags: ["run", run.status],
    projectId,
    source: "agent",
    extraMeta: { run: run.id },
  });
}

// ── Chat save-to-vault (S2) ──────────────────────────────────────────────────

async function saveChat({ chatId, mode = "message", messageId = null, brain = null }) {
  const chat = stmts.getChat.get(chatId);
  if (!chat) {
    const err = new Error("chat not found");
    err.code = "ENOTFOUND";
    throw err;
  }
  const messages = stmts.listChatMessages.all(chatId);
  const date = new Date().toISOString().slice(0, 10);

  if (mode === "message") {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) {
      const err = new Error("message not found");
      err.code = "ENOTFOUND";
      throw err;
    }
    return writeVaultFile({
      folder: "agent/chats",
      title: `${date} ${firstLineOf(msg.content) || chat.title || "chat"}`,
      body: msg.content || "",
      tags: ["chat"],
      source: "agent",
      extraMeta: { chat: chatId },
    });
  }

  // mode === "summary": brain-condense the whole conversation.
  const router = brain || require("./brain/router");
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content || ""}`)
    .join("\n\n")
    .slice(-12000);
  let text;
  try {
    const res = await router.complete({
      taskClass: "standard",
      intent: "vault_summary",
      system:
        "You condense a chat conversation into a knowledge-vault note. Capture decisions, " +
        "facts, and follow-ups as tight markdown bullets. Facts only.",
      prompt: transcript || "(empty conversation)",
    });
    text = res.text;
  } catch (err) {
    const e = new Error(`could not summarize: ${err.message}`);
    e.code = "EBRAIN";
    throw e;
  }
  return writeVaultFile({
    folder: "agent/chats",
    title: `${date} ${chat.title || "chat summary"}`,
    body: text,
    tags: ["chat", "summary"],
    source: "agent",
    extraMeta: { chat: chatId },
  });
}

// ── Recall / resurfacing (Phase Ω) ──────────────────────────────────────────
// The vault should make the user smarter, not just hold files: old-but-connected
// notes resurface as active-recall questions so they stay alive instead of being
// buried by new ones. Scoring is computed on the fly (age × connectedness); the
// only state is a settings-blob of "last resurfaced" stamps and a per-note
// question cache (regenerated only when the note itself changes).
const RECALL_KEY = "vault_recall_state";
const RECALL_SKIP_TYPES = new Set(["daily", "capture"]);
const RECALL_COOLDOWN_MS = 3 * 864e5; // a reviewed note rests 3 days

function recallStateLoad() {
  try {
    const row = stmts.getSetting.get(RECALL_KEY);
    const s = row ? JSON.parse(row.value) : null;
    return { seen: s?.seen || {}, questions: s?.questions || {} };
  } catch {
    return { seen: {}, questions: {} };
  }
}

function recallStateSave(state) {
  try {
    stmts.setSetting.run(RECALL_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/** Top-n notes due for a revisit, each with a recall question. */
async function recallQueue({ n = 3, brain = null } = {}) {
  const g = graph();
  const deg = new Map();
  for (const e of g.edges) {
    deg.set(e.src, (deg.get(e.src) || 0) + 1);
    deg.set(e.dst, (deg.get(e.dst) || 0) + 1);
  }
  const state = recallStateLoad();
  const now = Date.now();
  const scored = [];
  for (const node of g.nodes) {
    if (RECALL_SKIP_TYPES.has(node.type)) continue;
    const seenAt = Date.parse(state.seen[node.id] || "") || 0;
    if (now - seenAt < RECALL_COOLDOWN_MS) continue;
    const last = Math.max(Date.parse(node.updatedAt || "") || 0, seenAt);
    const ageDays = (now - last) / 864e5;
    if (ageDays < 2) continue; // fresh notes need no resurfacing
    scored.push({ node, score: ageDays * (1 + Math.log2(1 + (deg.get(node.id) || 0))) });
  }
  scored.sort((a, b) => b.score - a.score);
  const picks = scored.slice(0, Math.max(1, Math.min(10, n))).map((s) => s.node);

  // One batched brain call for cache misses; brain down → generic question.
  const missing = picks.filter((p) => state.questions[p.id]?.updatedAt !== p.updatedAt);
  if (missing.length) {
    const byId = {};
    try {
      const router = brain || require("./brain/router");
      const res = await router.complete({
        taskClass: "standard",
        intent: "vault_recall",
        system:
          "You turn personal knowledge notes into one short active-recall question each - the " +
          "kind a spaced-repetition system asks to keep a memory alive. Ask about the substance " +
          "of the note, answerable from it. Reply with ONLY a JSON array, no prose, no fences: " +
          '[{"id":"...","question":"..."}].',
        prompt: missing
          .map(
            (p) =>
              `id: ${p.id}\ntitle: ${p.title}\nbody:\n${(notes.getNote(p.id)?.body || "").slice(0, 1500)}`
          )
          .join("\n\n---\n\n"),
      });
      const arr = JSON.parse(
        String(res?.text || "")
          .replace(/^```(?:json)?\s*|```\s*$/gm, "")
          .trim()
      );
      if (Array.isArray(arr)) {
        for (const it of arr) if (it && it.id && it.question) byId[it.id] = String(it.question);
      }
    } catch {
      /* fallback below */
    }
    for (const p of missing) {
      state.questions[p.id] = {
        q: byId[p.id] || `What do you remember about "${p.title}"?`,
        updatedAt: p.updatedAt,
      };
    }
    const known = new Set(g.nodes.map((x) => x.id));
    for (const id of Object.keys(state.questions)) if (!known.has(id)) delete state.questions[id];
    recallStateSave(state);
  }

  return picks.map((p) => ({
    id: p.id,
    title: p.title,
    type: p.type,
    question: state.questions[p.id]?.q || `What do you remember about "${p.title}"?`,
    updatedAt: p.updatedAt,
  }));
}

/** Mark a note as reviewed - it rests, then re-earns its place by age. */
function recallSeen(id) {
  const state = recallStateLoad();
  state.seen[id] = new Date().toISOString();
  recallStateSave(state);
}

function firstLineOf(s) {
  return String(s || "")
    .split(/\r?\n/)[0]
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 60);
}

function safeTags(json) {
  try {
    const t = JSON.parse(json || "[]");
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

module.exports = {
  init,
  ensureVaultFolders,
  nodeType,
  parseWikilinks,
  normalizeKey,
  normalizeDateOfBirth,
  noteAliases,
  resolveKey,
  graph,
  node,
  pathBetween,
  writeVaultFile,
  appendFact,
  getSummaryProjects,
  setSummaryProjects,
  ensureProjectStub,
  attachRunSummaryWriter,
  saveChat,
  recallQueue,
  recallSeen,
  // test seams
  onIndexed,
  onRemoved,
  projectForRun,
  runOutputTail,
};
