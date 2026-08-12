/**
 * @file notes.js
 * @description Notes system (Phase G1). Notes are MARKDOWN FILES ON DISK - the
 * files are the system of record (Obsidian-compatible, agent-readable, editable
 * anywhere). SQLite's `notes` table is a rebuildable INDEX only; a watcher keeps
 * it in sync so an edit made in Obsidian (or by an agent, or by hand) shows up in
 * the dashboard without a manual rescan.
 *
 * Each file carries YAML frontmatter: id, title, tags, project, created, updated,
 * source (manual|dump|voice), and - for brain-dumps (Phase G2) - the verbatim
 * `original` text so nothing the user said is ever lost.
 *
 * Design per repo rules: additive, fail-safe (a bad file is skipped, never
 * crashes the index/watcher), and dependency-free - a tiny purpose-built
 * frontmatter parser rather than pulling in a YAML lib, and Node's `fs.watch`
 * (the same primitive lib/cc-watcher.js uses) rather than chokidar.
 *
 * @author Jarvis (Phase G)
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { db, stmts, NOTES_FTS_OK } = require("../db");

const NOTES_DIR_KEY = "notes_dir";
const EXCERPT_LEN = 280;

// ── FTS statements (prepared lazily + guarded - FTS5 may be absent) ──────────
let fts = null;
if (NOTES_FTS_OK) {
  try {
    fts = {
      del: db.prepare("DELETE FROM notes_fts WHERE note_id = ?"),
      ins: db.prepare("INSERT INTO notes_fts (note_id, title, tags, body) VALUES (?, ?, ?, ?)"),
      // Ranked search; bm25 puts the best matches first.
      search: db.prepare(
        "SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?"
      ),
    };
  } catch {
    fts = null;
  }
}

// ── Notes directory (a Settings-configurable path) ──────────────────────────

function defaultNotesDir() {
  return process.env.JARVIS_NOTES_DIR || path.join(os.homedir(), "JarvisNotes");
}

/** The active notes directory: app_settings override → env → ~/JarvisNotes. */
function getNotesDir() {
  try {
    const row = stmts.getSetting.get(NOTES_DIR_KEY);
    if (row && typeof row.value === "string" && row.value.trim()) return row.value.trim();
  } catch {
    /* fall through to default */
  }
  return defaultNotesDir();
}

function setNotesDir(dir) {
  const clean = typeof dir === "string" ? dir.trim() : "";
  if (!clean) throw new Error("notes directory path is required");
  const resolved = path.resolve(untilde(clean));
  fs.mkdirSync(resolved, { recursive: true });
  stmts.setSetting.run(NOTES_DIR_KEY, resolved);
  reindexAll();
  return resolved;
}

function untilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureNotesDir() {
  const dir = getNotesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort - index/watcher still guard every fs call */
  }
  return dir;
}

// ── Minimal YAML frontmatter (parse + serialize; no dependency) ─────────────
// Supports the small shape notes use: scalars, inline `[a, b]` arrays, block
// `- item` arrays, and `|` block scalars (for the verbatim dump `original`).

function parseFrontmatter(raw) {
  const text = String(raw || "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = parseYamlBlock(m[1]);
  return { meta, body: m[2] || "" };
}

function parseYamlBlock(block) {
  const lines = block.split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (val === "|" || val === "|-" || val === ">") {
      // Block scalar: consume subsequent more-indented lines verbatim.
      const collected = [];
      while (i + 1 < lines.length && (lines[i + 1] === "" || /^\s+/.test(lines[i + 1]))) {
        collected.push(lines[++i].replace(/^ {2}/, ""));
      }
      meta[key] = collected.join("\n").replace(/\n+$/, "");
    } else if (val === "") {
      // Possible block array (`- item` lines follow).
      const arr = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
      }
      meta[key] = arr.length ? arr : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      meta[key] = unquote(val);
    }
  }
  return meta;
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function serializeFrontmatter(meta) {
  const lines = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map((v) => yamlScalar(v)).join(", ")}]`);
    } else if (typeof val === "string" && val.includes("\n")) {
      lines.push(`${key}: |`);
      for (const l of val.split("\n")) lines.push(`  ${l}`);
    } else {
      lines.push(`${key}: ${yamlScalar(val)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(v) {
  const s = String(v);
  if (s === "" || /[:#\[\]{}",]|^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

function isSensitiveValue(value) {
  return value === true || value === "true";
}

// ── Building a note file's contents ─────────────────────────────────────────

function buildNoteFile({
  id,
  title,
  tags,
  projectId,
  source,
  sensitive,
  created,
  updated,
  original,
  body,
}) {
  const meta = {
    id,
    title: title || "Untitled",
    tags: Array.isArray(tags) ? tags : [],
    project: projectId || "",
    created: created || nowIso(),
    updated: updated || nowIso(),
    source: source || "manual",
  };
  if (sensitive) meta.sensitive = true;
  if (original) meta.original = original;
  return `${serializeFrontmatter(meta)}\n\n${(body || "").trim()}\n`;
}

function nowIso() {
  return new Date().toISOString();
}

function excerptOf(body) {
  const plain = String(body || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, EXCERPT_LEN);
}

function slugify(title) {
  const base = String(title || "note")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "note";
}

// ── Vault hooks (Phase S) ────────────────────────────────────────────────────
// The vault (server/lib/vault.js) maintains a wikilink/relation edge index over
// the same files. It registers here so edges are (re)built exactly when a file
// is (re)indexed - one pipeline, no second watcher. Injected to avoid a require
// cycle; both callbacks are fail-safe (a throwing hook never breaks indexing).

let vaultHooks = null;

function setVaultHooks(hooks) {
  vaultHooks = hooks && typeof hooks === "object" ? hooks : null;
}

// ── Index sync (files → SQLite) ─────────────────────────────────────────────

/** Read one markdown file and (re)index it. Returns the index row, or null if
 *  the file is unreadable. Fail-safe: never throws. */
function indexFile(absPath) {
  let raw, stat;
  try {
    raw = fs.readFileSync(absPath, "utf8");
    stat = fs.statSync(absPath);
  } catch {
    removeFromIndex(absPath);
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const existing = safeGetByPath(absPath);
  const id = cleanId(meta.id) || (existing && existing.id) || randomUUID();
  const tags = normalizeTags(meta.tags);
  const row = {
    id,
    path: absPath,
    title: (typeof meta.title === "string" && meta.title.trim()) || fileTitle(absPath),
    tags: JSON.stringify(tags),
    project_id: cleanId(meta.project) || null,
    source: typeof meta.source === "string" ? meta.source : "manual",
    excerpt: excerptOf(body),
    sensitive: isSensitiveValue(meta.sensitive) ? 1 : 0,
    mtime: stat.mtime.toISOString(),
    created_at: typeof meta.created === "string" ? meta.created : nowIso(),
    updated_at: typeof meta.updated === "string" ? meta.updated : stat.mtime.toISOString(),
  };
  try {
    reindexRow(row, body, tags);
  } catch {
    return null;
  }
  if (vaultHooks && typeof vaultHooks.indexed === "function") {
    try {
      vaultHooks.indexed(row, body, meta);
    } catch {
      /* vault edge indexing must never break note indexing */
    }
  }
  return row;
}

// Replace the index + FTS entry for a path atomically. Delete-by-path first so a
// changed frontmatter id doesn't leave a stale row; delete the old id's FTS too.
const reindexTx = db.transaction((row, body, tags) => {
  const prev = safeGetByPath(row.path);
  stmts.deleteNoteByPath.run(row.path);
  // A frontmatter id collision with a *different* path shouldn't wedge the index.
  stmts.deleteNote.run(row.id);
  stmts.insertNote.run(row);
  if (fts) {
    if (prev) fts.del.run(prev.id);
    fts.del.run(row.id);
    fts.ins.run(row.id, row.title, tags.join(" "), body);
  }
});

function reindexRow(row, body, tags) {
  reindexTx(row, body, tags);
}

function removeFromIndex(absPath) {
  try {
    const prev = safeGetByPath(absPath);
    stmts.deleteNoteByPath.run(absPath);
    if (fts && prev) fts.del.run(prev.id);
    if (prev && vaultHooks && typeof vaultHooks.removed === "function") {
      try {
        vaultHooks.removed(prev.id);
      } catch {
        /* fail-safe */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Full rebuild: index every .md under the notes dir, prune rows whose file is
 *  gone. Cheap enough to run on boot and on notes-dir change. */
function reindexAll() {
  const dir = ensureNotesDir();
  const seen = new Set();
  for (const abs of walkMarkdown(dir)) {
    if (indexFile(abs)) seen.add(abs);
  }
  try {
    for (const r of stmts.allNotePaths.all()) {
      if (!seen.has(r.path)) removeFromIndex(r.path);
    }
  } catch {
    /* ignore */
  }
  return seen.size;
}

function walkMarkdown(dir, out = [], depth = 0) {
  if (depth > 6) return out; // guard against symlink loops
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    // Graphify codegraph exports (Phase T3) are Obsidian-only: thousands of
    // per-symbol notes would bloat FTS and turn the wikilink resolver's linear
    // scans quadratic. The dashboard shows one overview note per codegraph.
    // ponytail: skipped, not indexed - add a keyed resolver first if dashboard
    // code-search over these is ever wanted.
    if (ent.isDirectory() && ent.name === "codegraph") continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMarkdown(abs, out, depth + 1);
    else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(abs);
  }
  return out;
}

function fileTitle(absPath) {
  return path.basename(absPath).replace(/\.md$/i, "");
}

function safeGetByPath(p) {
  try {
    return stmts.getNoteByPath.get(p) || null;
  } catch {
    return null;
  }
}

function cleanId(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string" && tags.trim()) {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

// ── CRUD (index + file kept in lockstep) ────────────────────────────────────

function toApiNote(row, body) {
  if (!row) return null;
  let tags = [];
  try {
    tags = JSON.parse(row.tags || "[]");
  } catch {
    tags = [];
  }
  const out = {
    id: row.id,
    path: row.path,
    title: row.title,
    tags,
    projectId: row.project_id,
    source: row.source,
    excerpt: row.excerpt,
    sensitive: row.sensitive === 1,
    mtime: row.mtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (body !== undefined) out.body = body;
  return out;
}

function readBody(absPath) {
  try {
    return parseFrontmatter(fs.readFileSync(absPath, "utf8")).body;
  } catch {
    return "";
  }
}

function readOriginal(absPath) {
  try {
    const m = parseFrontmatter(fs.readFileSync(absPath, "utf8")).meta;
    return typeof m.original === "string" ? m.original : null;
  } catch {
    return null;
  }
}

/** Create a note file and index it. Returns the API note (with body). */
function createNote({
  title,
  body = "",
  tags = [],
  projectId = null,
  source = "manual",
  original = null,
  sensitive = false,
} = {}) {
  const dir = ensureNotesDir();
  const id = randomUUID();
  const created = nowIso();
  const file = uniquePath(dir, slugify(title || firstLine(body) || "note"));
  const contents = buildNoteFile({
    id,
    title: title || firstLine(body) || "Untitled",
    tags: normalizeTags(tags),
    projectId,
    source,
    sensitive: isSensitiveValue(sensitive),
    created,
    updated: created,
    original,
    body,
  });
  fs.writeFileSync(file, contents, "utf8");
  const row = indexFile(file);
  return toApiNote(row || safeGetByPath(file), body);
}

/** Update a note by id: rewrite its file (preserving id/created/original) and
 *  reindex. Returns the updated API note, or null if not found. */
function updateNote(id, patch = {}, { includeSensitive = false } = {}) {
  const existing = safeGet(id);
  if (!isVisible(existing, includeSensitive)) return null;
  if (!includeSensitive && isSensitiveValue(patch.sensitive)) return null;
  const absPath = existing.path;
  const prevBody = readBody(absPath);
  const prevOriginal = readOriginal(absPath);
  let existingTags = [];
  try {
    existingTags = JSON.parse(existing.tags || "[]");
  } catch {
    existingTags = [];
  }
  const contents = buildNoteFile({
    id: existing.id,
    title: patch.title !== undefined ? patch.title : existing.title,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existingTags,
    projectId: patch.projectId !== undefined ? patch.projectId : existing.project_id,
    source: existing.source,
    sensitive:
      patch.sensitive === undefined ? existing.sensitive === 1 : isSensitiveValue(patch.sensitive),
    created: existing.created_at,
    updated: nowIso(),
    original: prevOriginal,
    body: patch.body !== undefined ? patch.body : prevBody,
  });
  try {
    fs.writeFileSync(absPath, contents, "utf8");
  } catch (err) {
    throw new Error(`could not write note file: ${err.message}`);
  }
  const row = indexFile(absPath);
  return toApiNote(row || safeGet(id), patch.body !== undefined ? patch.body : prevBody);
}

/** Delete a note by id: remove its file and index row. */
function deleteNote(id, { includeSensitive = false } = {}) {
  const existing = safeGet(id);
  if (!isVisible(existing, includeSensitive)) return false;
  try {
    fs.unlinkSync(existing.path);
  } catch {
    /* file already gone - still drop the index row below */
  }
  removeFromIndex(existing.path);
  return true;
}

function getNote(id, { includeSensitive = false } = {}) {
  const row = safeGet(id);
  if (!isVisible(row, includeSensitive)) return null;
  return toApiNote(row, readBody(row.path));
}

/** List / search notes. `q` uses FTS5 (falls back to a substring scan); `tag`
 *  and `projectId` filter the index. */
function listNotes({
  q = null,
  tag = null,
  projectId = null,
  limit = 200,
  includeSensitive = false,
} = {}) {
  let rows;
  try {
    rows = projectId ? stmts.listNotesByProject.all(projectId) : stmts.listNotes.all();
  } catch {
    rows = [];
  }
  rows = rows.filter((row) => isVisible(row, includeSensitive));
  if (projectId && q == null && tag == null) {
    // already filtered
  }
  if (q && q.trim()) {
    const ids = searchIds(q.trim(), limit);
    if (ids) {
      const order = new Map(ids.map((v, i) => [v, i]));
      rows = rows.filter((r) => order.has(r.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    } else {
      const needles = (q.match(/[A-Za-z0-9_]+/g) || [])
        .flatMap(searchTerms)
        .filter((term) => term.length > 1);
      rows = rows.filter(
        (r) =>
          needles.some((needle) => (r.title || "").toLowerCase().includes(needle)) ||
          needles.some((needle) => readBody(r.path).toLowerCase().includes(needle))
      );
    }
  }
  if (tag && tag.trim()) {
    const want = tag.trim().toLowerCase();
    rows = rows.filter((r) => {
      try {
        return JSON.parse(r.tags || "[]").some((t) => String(t).toLowerCase() === want);
      } catch {
        return false;
      }
    });
  }
  return rows.slice(0, limit).map((r) => toApiNote(r));
}

/** FTS5 search → ordered note ids, or null when FTS is unavailable/errored so
 *  the caller can fall back to a substring scan. */
function searchIds(q, limit) {
  if (!fts) return null;
  try {
    const rows = fts.search.all(ftsQuery(q), limit);
    return rows.map((r) => r.note_id);
  } catch {
    return null;
  }
}

// Turn free text into a safe FTS5 prefix query (each token → token*), quoting to
// neutralize FTS operators the user didn't mean to type.
function ftsQuery(q) {
  const tokens = q.match(/[A-Za-z0-9_]+/g) || [];
  if (!tokens.length) return '""';
  return tokens
    .map((t) => {
      const forms = searchTerms(t).map((form) => `"${form}"*`);
      return forms.length === 1 ? forms[0] : `(${forms.join(" OR ")})`;
    })
    .join(" ");
}

function searchTerms(q) {
  const term = String(q || "")
    .trim()
    .toLowerCase();
  const forms = new Set([term]);
  if (term.length > 4 && term.endsWith("ies")) forms.add(`${term.slice(0, -3)}y`);
  else if (term.length > 4 && term.endsWith("es")) forms.add(term.slice(0, -2));
  else if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss"))
    forms.add(term.slice(0, -1));
  return [...forms].filter(Boolean);
}

/** Distinct tags across all notes with counts (for the filter chips). */
function listTags({ includeSensitive = false } = {}) {
  const counts = new Map();
  let rows = [];
  try {
    rows = stmts.listNotes.all();
  } catch {
    rows = [];
  }
  for (const r of rows.filter((row) => isVisible(row, includeSensitive))) {
    let tags = [];
    try {
      tags = JSON.parse(r.tags || "[]");
    } catch {
      tags = [];
    }
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function isVisible(row, includeSensitive) {
  return Boolean(row) && (includeSensitive || row.sensitive !== 1);
}

function safeGet(id) {
  try {
    return stmts.getNote.get(id) || null;
  } catch {
    return null;
  }
}

function firstLine(body) {
  const l = String(body || "").split(/\r?\n/)[0] || "";
  return l.replace(/^#+\s*/, "").trim();
}

function uniquePath(dir, slug) {
  let candidate = path.join(dir, `${slug}.md`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${slug}-${n}.md`);
    n++;
  }
  return candidate;
}

// ── Watcher (files edited anywhere → live reindex + WS broadcast) ────────────

let watcher = null;
let debounceTimer = null;
const pendingPaths = new Set();

function startNotesWatcher({ broadcast } = {}) {
  const dir = ensureNotesDir();
  reindexAll();
  stopNotesWatcher();
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        scheduleReindexAll(broadcast);
        return;
      }
      const abs = path.join(dir, filename.toString());
      if (!/\.md$/i.test(abs)) return;
      if (abs.split(path.sep).includes("codegraph")) return; // Obsidian-only (T3)
      pendingPaths.add(abs);
      scheduleFlush(broadcast);
    });
    watcher.on("error", () => {
      /* recursive watch unsupported on some FS - the boot reindex still ran */
    });
  } catch {
    // Platform without recursive fs.watch: fall back to a periodic reindex.
    watcher = setInterval(() => scheduleReindexAll(broadcast), 30_000);
    if (watcher.unref) watcher.unref();
  }
}

function scheduleFlush(broadcast) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const paths = [...pendingPaths];
    pendingPaths.clear();
    for (const p of paths) {
      const exists = fs.existsSync(p);
      if (exists) indexFile(p);
      else removeFromIndex(p);
    }
    emit(broadcast, "note_changed", { count: paths.length });
  }, 300);
  if (debounceTimer.unref) debounceTimer.unref();
}

function scheduleReindexAll(broadcast) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const n = reindexAll();
    emit(broadcast, "note_changed", { count: n, full: true });
  }, 500);
  if (debounceTimer.unref) debounceTimer.unref();
}

function emit(broadcast, type, data) {
  if (typeof broadcast === "function") {
    try {
      broadcast(type, data);
    } catch {
      /* best-effort */
    }
  }
}

function stopNotesWatcher() {
  if (!watcher) return;
  try {
    if (typeof watcher.close === "function") watcher.close();
    else clearInterval(watcher);
  } catch {
    /* ignore */
  }
  watcher = null;
}

module.exports = {
  getNotesDir,
  setNotesDir,
  defaultNotesDir,
  ensureNotesDir,
  reindexAll,
  indexFile,
  createNote,
  updateNote,
  deleteNote,
  getNote,
  listNotes,
  listTags,
  startNotesWatcher,
  stopNotesWatcher,
  setVaultHooks,
  // exposed for tests / brain dump flow
  parseFrontmatter,
  serializeFrontmatter,
  toApiNote,
};
