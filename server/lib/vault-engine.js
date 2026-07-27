/**
 * @file vault-engine.js
 * @description Vault entity engine (Phase T). A manually-triggered pass over
 * notes changed since the last run: extracts named entities via the brain
 * router, tracks mentions in vault_entities/vault_mentions, promotes an entity
 * to a real vault file once it has been mentioned in 2+ distinct notes (or
 * attaches immediately when a note by that name already exists), and writes
 * `[[wikilinks]]` into every mentioning note - inside ONE engine-owned block:
 *
 *   <!-- jarvis:links -->
 *   Related: [[Alex]], [[Acme Travel]]
 *   <!-- /jarvis:links -->
 *
 * Human prose is never touched: the block is swapped by raw text replacement
 * (no frontmatter parse→serialize round trip, so nothing else in the file can
 * be reformatted), and rewrites are idempotent - same link set, no write, no
 * watcher churn. The engine writes markdown, never vault_edges directly; the
 * watcher reindexes the file and vault.js's wikilink pass builds the edges,
 * exactly as if a human had typed the link.
 *
 * Progress streams over the websocket as `vault_engine` events so the Vault
 * page can animate the brain "thinking" (scan pulses, promotions, new links).
 * Manual trigger only - no cron (locked with the user in PLAN-vault-brain.md).
 *
 * @author Jarvis (Phase T)
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { stmts } = require("../db");
const notes = require("./notes");
const vault = require("./vault");
const { broadcast } = require("../websocket");

const LAST_RUN_KEY = "vault_engine_last_run";
const EPOCH = "1970-01-01T00:00:00.000Z";
const LINKS_BLOCK_RE = /[ \t]*<!-- jarvis:links -->[\s\S]*?<!-- \/jarvis:links -->/;
// Prompt hint, not an enforced enum - unknown types fold to "topic".
const ENTITY_TYPES = ["person", "project", "organization", "topic", "place", "event", "technology"];
const MAX_PROMPT_CHARS = 6000;
const PROMOTE_AT = 2; // distinct mentioning notes before an entity gets a file

let running = false;

function emit(data) {
  try {
    broadcast("vault_engine", data);
  } catch {
    /* fail-safe: progress is cosmetic */
  }
}

/** Run one extraction→promotion→linking pass. Overlap-guarded; the caller
 *  (route) decides when. Returns counters for the status line. */
async function runEngine({ router } = {}) {
  if (running) {
    const err = new Error("vault engine is already running");
    err.code = "EBUSY";
    throw err;
  }
  running = true;
  try {
    return await pass(router || require("./brain/router"));
  } finally {
    running = false;
  }
}

async function pass(router) {
  const lastRun = getLastRun();
  const cursor = new Date().toISOString();
  const result = {
    notesScanned: 0,
    entitiesSeen: 0,
    entitiesCreated: 0,
    notesLinked: 0,
    errors: 0,
  };

  let rows = [];
  try {
    // >= not >: a note saved in the same millisecond as the previous pass's
    // cursor would otherwise be skipped forever, since the cursor has already
    // moved past it. The pass is idempotent, so re-scanning a boundary note
    // costs one extraction and changes nothing.
    rows = stmts.listNotes
      .all()
      .filter((r) => !isSkippedPath(r.path) && (r.updated_at || "") >= lastRun);
  } catch {
    rows = [];
  }
  emit({ phase: "start", total: rows.length });

  // 1) Extract + record mentions, note by note (sequential - free-tier LLM
  //    rate limits; a personal vault's daily delta is small).
  for (const row of rows) {
    result.notesScanned++;
    emit({ phase: "scan", noteId: row.id, title: row.title });
    let extracted;
    try {
      extracted = await extractEntities(row, router);
    } catch {
      result.errors++;
      continue;
    }
    result.entitiesSeen += extracted.length;
    for (const ent of extracted) recordMention(row.id, ent);
    if (extracted.length) {
      emit({ phase: "entities", noteId: row.id, names: extracted.map((e) => e.name) });
    }
  }

  // 2) Promote entities that crossed the threshold.
  for (const entity of listEntities()) {
    if (entity.note_id) continue;
    let n = 0;
    try {
      n = stmts.countVaultMentions.get(entity.id).n;
    } catch {
      n = 0;
    }
    if (n < PROMOTE_AT) continue;
    const noteId = promoteEntity(entity);
    if (noteId) {
      result.entitiesCreated++;
      emit({ phase: "promoted", noteId, title: entity.name, type: entity.type });
    }
  }

  // 3) Relink every note that mentions a promoted entity - including notes
  //    from BEFORE this run, so the first mention (the song lyric that named
  //    Alex before he had a page) gets its link retroactively.
  const relink = new Set(rows.map((r) => r.id));
  for (const entity of listEntities()) {
    if (!entity.note_id) continue;
    try {
      for (const m of stmts.listVaultMentionNotes.all(entity.id)) relink.add(m.note_id);
    } catch {
      /* partial is fine */
    }
  }
  for (const noteId of relink) {
    try {
      const linked = relinkNote(noteId);
      if (linked) {
        result.notesLinked++;
        emit({ phase: "linked", noteId, titles: linked });
      }
    } catch {
      result.errors++;
    }
  }

  setLastRun(cursor);
  emit({ phase: "done", ...result });
  return result;
}

// ── Scope ────────────────────────────────────────────────────────────────────

/** Engine never scans agent memories (noise) or graphify codegraph exports. */
function isSkippedPath(absPath) {
  const rel = path.relative(notes.getNotesDir(), absPath);
  if (rel.startsWith("..")) return true;
  const parts = rel.split(path.sep);
  return parts[0] === "agent" || parts.includes("codegraph");
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Titles of every note in the vault - the roster we hand the model so it can
 *  reason about connections across notes, not just names inside this one. */
function vaultRoster() {
  try {
    return stmts.listNotes
      .all()
      .filter((r) => !isSkippedPath(r.path))
      .map((r) => r.title)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function extractEntities(row, router) {
  const note = notes.getNote(row.id);
  const text = String(note?.body || "")
    .replace(LINKS_BLOCK_RE, "") // never re-extract from our own block
    .slice(0, MAX_PROMPT_CHARS)
    .trim();
  if (!text) return [];
  // ponytail: whole vault roster in every prompt - fine at personal-vault
  // scale; page/retrieve the roster if it ever outgrows one context.
  const roster = vaultRoster().filter((t) => t !== (row.title || ""));
  const res = await router.complete({
    taskClass: "complex", // route to the claude provider (Opus) - reason, don't string-match
    intent: "vault_entity_extract",
    system:
      "You read a personal note and identify the people, projects, organizations, topics, and " +
      "places it connects to in this knowledge vault. Reason about the connections, don't just " +
      "match names. You are given a roster of notes that already exist. Include any roster item this " +
      "note is genuinely related to - even when this note doesn't name it directly - whenever the " +
      "relationship is clear from context: family (two people whose parents are siblings are cousins), " +
      "work (colleagues at the same employer, a project and its client), or subject (a topic and the " +
      "project that applies it). Never invent an item that is neither in the note nor the roster. " +
      "Reply with ONLY a JSON array, no prose, no markdown fences: " +
      '[{"name":"...","type":"person|project|organization|topic|place|event|technology","aliases":["..."]}]. ' +
      "Skip generic words, dates, and one-off nouns. Reply [] when there are none.",
    prompt:
      `Note title: ${row.title || "Untitled"}\n\n${text}\n\n` +
      `Existing notes in the vault:\n${roster.join(", ") || "(none yet)"}`,
  });
  return parseEntitiesJson(res?.text);
}

/** Defensive parse: models wrap JSON in fences or prose; salvage the array. */
function parseEntitiesJson(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && typeof e.name === "string" && e.name.trim() && e.name.trim().length <= 80)
    .map((e) => ({
      name: e.name.trim(),
      type: ENTITY_TYPES.includes(e.type) ? e.type : "topic",
      aliases: Array.isArray(e.aliases)
        ? e.aliases
            .filter((a) => typeof a === "string" && a.trim() && a.trim().length <= 80)
            .map((a) => a.trim())
            .slice(0, 5)
        : [],
    }));
}

// ── Matching + mention tracking ──────────────────────────────────────────────

function listEntities() {
  try {
    return stmts.listVaultEntities.all();
  } catch {
    return [];
  }
}

/** Match an extracted entity against known entities by normalized name/alias.
 *  ponytail: linear scan - fine at personal-vault scale, key an index column
 *  if entities ever reach tens of thousands. */
function findEntity(name, aliases = []) {
  const keys = new Set([name, ...aliases].map((k) => vault.normalizeKey(k)).filter(Boolean));
  for (const e of listEntities()) {
    if (keys.has(vault.normalizeKey(e.name))) return e;
    for (const a of safeArray(e.aliases)) {
      if (keys.has(vault.normalizeKey(a))) return e;
    }
  }
  return null;
}

function recordMention(noteId, ent) {
  let entity = findEntity(ent.name, ent.aliases);
  if (!entity) {
    // A note may already answer to this name (e.g. people/mushaf-zarrar.md):
    // attach immediately - the node exists, no need to wait for mention #2.
    const existingNote = vault.resolveKey(vault.normalizeKey(ent.name));
    const id = randomUUID();
    try {
      stmts.insertVaultEntity.run({
        id,
        name: ent.name,
        type: ent.type,
        aliases: JSON.stringify(ent.aliases),
        note_id: existingNote || null,
      });
      entity = stmts.getVaultEntity.get(id);
    } catch {
      return;
    }
  }
  if (!entity || entity.note_id === noteId) return; // a note doesn't mention itself
  try {
    stmts.insertVaultMention.run(entity.id, noteId);
  } catch {
    /* fail-safe */
  }
}

function safeArray(json) {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ── Promotion ────────────────────────────────────────────────────────────────

function promoteEntity(entity) {
  try {
    const aliases = safeArray(entity.aliases);
    const note = vault.writeVaultFile({
      folder: entity.type === "person" ? "people" : "reference",
      title: entity.name,
      body: `*Auto-created by the vault engine - mentioned across your notes. Backlinks show where.*`,
      tags: [entity.type],
      source: "engine",
      // Obsidian-native alias resolution: [[Alex Rivera]] finds this note too.
      extraMeta: aliases.length ? { aliases } : {},
    });
    stmts.setVaultEntityNoteId.run(note.id, entity.id);
    return note.id;
  } catch (err) {
    console.warn("[vault-engine] promote failed:", err?.message || err);
    return null;
  }
}

// ── Linking ──────────────────────────────────────────────────────────────────

/** Regenerate the engine block in one note. Returns the linked titles when a
 *  write happened, null when the block was already up to date. */
function relinkNote(noteId) {
  const row = safeGetRow(noteId);
  if (!row || isSkippedPath(row.path)) return null;
  let entities = [];
  try {
    entities = stmts.listVaultEntitiesForNote.all(noteId);
  } catch {
    entities = [];
  }
  const titles = [
    ...new Set(
      entities
        .filter((e) => e.note_id && e.note_id !== noteId)
        .map((e) => {
          const target = safeGetRow(e.note_id);
          return target ? target.title : null;
        })
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
  return upsertLinksBlock(row.path, titles) ? titles : null;
}

/** Swap/append the engine-owned block by RAW text replacement - everything
 *  outside the markers stays byte-identical. Returns true when written. */
function upsertLinksBlock(absPath, titles) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  const block = titles.length
    ? `<!-- jarvis:links -->\nRelated: ${titles.map((t) => `[[${t}]]`).join(", ")}\n<!-- /jarvis:links -->`
    : "";
  const m = raw.match(LINKS_BLOCK_RE);
  if ((m ? m[0].trim() : "") === block) return false; // idempotent

  let next;
  if (m) {
    next = block
      ? raw.replace(LINKS_BLOCK_RE, block)
      : raw.replace(LINKS_BLOCK_RE, "").replace(/\n{3,}$/, "\n");
  } else {
    next = `${raw.replace(/\s*$/, "")}\n\n${block}\n`;
  }
  try {
    fs.writeFileSync(absPath, next, "utf8");
    notes.indexFile(absPath); // immediate - don't wait for the watcher debounce
    return true;
  } catch (err) {
    console.warn("[vault-engine] relink write failed:", err?.message || err);
    return false;
  }
}

function safeGetRow(id) {
  try {
    return stmts.getNote.get(id) || null;
  } catch {
    return null;
  }
}

// ── Cursor + status ──────────────────────────────────────────────────────────

function getLastRun() {
  try {
    const row = stmts.getSetting.get(LAST_RUN_KEY);
    return row ? row.value : EPOCH;
  } catch {
    return EPOCH;
  }
}

function setLastRun(iso) {
  try {
    stmts.setSetting.run(LAST_RUN_KEY, iso);
  } catch {
    /* fail-safe */
  }
}

function getStatus() {
  const entities = listEntities();
  const lastRun = getLastRun();
  return {
    running,
    lastRun: lastRun === EPOCH ? null : lastRun,
    totalEntities: entities.length,
    promotedEntities: entities.filter((e) => e.note_id).length,
  };
}

module.exports = {
  runEngine,
  getStatus,
  // test seams
  parseEntitiesJson,
  extractEntities,
  findEntity,
  recordMention,
  promoteEntity,
  relinkNote,
  upsertLinksBlock,
  isSkippedPath,
};
