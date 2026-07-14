/**
 * @file codex-watcher.js
 * @description Passive Codex session monitoring (Phase AB1). Codex CLI writes
 * rollout JSONLs under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 * and emits no hooks, so - like workflow-ingest - everything is derived from
 * disk. Each rollout is parsed defensively (two schema generations are handled;
 * unknown event types are skipped, never fatal) and upserted into the existing
 * `sessions` surface with `provider: 'codex'` (additive column, default
 * 'claude'). Codex sessions are READ-ONLY v1: no steer/kill claims.
 *
 * Rollout schemas seen in the wild (real files, not memory):
 *   - 2025-08 flat: first line `{id, timestamp, instructions, git}` then
 *     `{type:"message", role, content:[{type:"input_text"|"output_text", text}]}`
 *     lines. cwd only appears inside an `<environment_context>` XML block.
 *   - 2026 wrapped: every line `{timestamp, type, payload}` with types
 *     session_meta / turn_context / response_item / event_msg (token_count
 *     carries cumulative usage) / compacted.
 *
 * Usage note: Codex has no headless `/status` equivalent (openai/codex#10233),
 * so token counts come from the rollouts alone and the limit window is
 * reported as "unknown" - `usageSummary()` is honest about that boundary.
 *
 * Fail-safe posture mirrors cc-watcher.js: fs.watch is best-effort, every
 * parse/DB touch is guarded, and a broken file is skipped, never thrown.
 *
 * @author Jarvis (Phase AB1)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// A rollout whose file changed within this window is considered live.
const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024; // skip pathological rollouts
const DEBOUNCE_MS = 1500;
const NAME_MAX = 80;

function codexSessionsDir() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** uuid + timestamp from a `rollout-<iso-with-dashes>-<uuid>.jsonl` basename. */
function parseRolloutFilename(file) {
  const base = path.basename(file, ".jsonl");
  const m = base.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-fA-F-]{36})$/);
  if (!m) return { id: null, startedAt: null };
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  const t = Date.parse(iso);
  return {
    id: m[2].toLowerCase(),
    startedAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
  };
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** First human ask, skipping harness boilerplate (env context, IDE wrapper). */
function pickName(userTexts) {
  for (const raw of userTexts) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const marker = text.indexOf("## My request for Codex:");
    if (marker >= 0) {
      const ask = text.slice(marker + "## My request for Codex:".length).trim();
      if (ask) return firstLine(ask);
      continue;
    }
    if (text.startsWith("<")) continue; // <environment_context>, <user_instructions>, …
    if (text.startsWith("# Context from my IDE")) continue;
    return firstLine(text);
  }
  return null;
}

function firstLine(s) {
  const line = String(s).split("\n")[0].trim();
  return line.length > NAME_MAX ? line.slice(0, NAME_MAX - 1) + "…" : line;
}

function asTokenTotals(u) {
  if (!u || typeof u !== "object" || !Number.isFinite(u.input_tokens)) return null;
  return {
    input: u.input_tokens || 0,
    cachedInput: u.cached_input_tokens || 0,
    output: u.output_tokens || 0,
    total: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
  };
}

/**
 * Parse one rollout file into a session-shaped record. Returns null when the
 * file is unreadable or carries nothing usable. Never throws.
 */
function parseRolloutFile(file) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const fromName = parseRolloutFilename(file);
  let id = fromName.id;
  let startedAt = fromName.startedAt;
  let cwd = null;
  let model = null;
  let git = null;
  let cliVersion = null;
  let tokens = null; // cumulative - last token_count wins
  let messages = 0;
  const userTexts = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;

    // Meta: old flat first line, or new wrapped session_meta payload.
    const meta = o.type === "session_meta" ? o.payload : !o.type && o.id ? o : null;
    if (meta && typeof meta === "object") {
      if (typeof meta.id === "string") id = meta.id;
      if (meta.timestamp) {
        const t = Date.parse(meta.timestamp);
        if (!Number.isNaN(t)) startedAt = new Date(t).toISOString();
      }
      if (typeof meta.cwd === "string") cwd = meta.cwd;
      if (meta.git && typeof meta.git === "object") git = meta.git;
      if (typeof meta.cli_version === "string") cliVersion = meta.cli_version;
      continue;
    }

    if (o.type === "turn_context" && o.payload && typeof o.payload === "object") {
      if (typeof o.payload.cwd === "string") cwd = o.payload.cwd;
      if (typeof o.payload.model === "string") model = o.payload.model;
      continue;
    }

    // Conversation items: old flat `message` lines or wrapped response_items.
    const item = o.type === "message" ? o : o.type === "response_item" ? o.payload : null;
    if (item && item.type === "message" && item.role) {
      messages += 1;
      const text = textOfContent(item.content);
      if (item.role === "user") {
        userTexts.push(text);
        if (!cwd) {
          const m = text.match(/<cwd>([^<]+)<\/cwd>/);
          if (m) cwd = m[1].trim();
        }
      }
      continue;
    }

    if (o.type === "event_msg" && o.payload && typeof o.payload === "object") {
      const p = o.payload;
      if (p.type === "token_count") {
        const totals =
          asTokenTotals(p.info && p.info.total_token_usage) ||
          asTokenTotals(p.info) ||
          asTokenTotals(p);
        if (totals) tokens = totals;
      } else if (p.type === "user_message" && typeof p.message === "string") {
        userTexts.push(p.message);
      }
      if (typeof p.model === "string" && !model) model = p.model;
    }
    // Anything else (state records, compacted, function calls, …) is skipped.
  }

  if (!id) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* keep 0 */
  }

  return {
    id,
    startedAt: startedAt || (mtimeMs ? new Date(mtimeMs).toISOString() : null),
    mtimeMs,
    cwd,
    model,
    git,
    cliVersion,
    tokens,
    messages,
    name: pickName(userTexts),
    rolloutPath: file,
  };
}

/** All rollout JSONLs under the date-partitioned sessions tree. */
function listRolloutFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  const out = [];
  for (const rel of entries) {
    const name = String(rel);
    if (name.startsWith("rollout-") || /[\\/]rollout-[^\\/]+\.jsonl$/.test(name)) {
      if (name.endsWith(".jsonl")) out.push(path.join(dir, name));
    }
  }
  return out;
}

// ── Ingestion ────────────────────────────────────────────────────────────────

const SESSION_ID_PREFIX = "codex-";

let sweepStmts = null;
function getStmts(dbModule) {
  if (sweepStmts) return sweepStmts;
  const { db } = dbModule;
  sweepStmts = {
    get: db.prepare("SELECT id, status, name, model FROM sessions WHERE id = ?"),
    insert: db.prepare(
      `INSERT INTO sessions (id, name, status, cwd, model, provider, started_at, ended_at, updated_at, metadata)
       VALUES (@id, @name, @status, @cwd, @model, 'codex', @started_at, @ended_at, @updated_at, @metadata)`
    ),
    update: db.prepare(
      `UPDATE sessions SET name = COALESCE(@name, name), status = @status,
         cwd = COALESCE(@cwd, cwd), model = COALESCE(@model, model),
         ended_at = @ended_at, updated_at = @updated_at, metadata = @metadata
       WHERE id = @id`
    ),
    activeRows: db.prepare(
      "SELECT id, metadata FROM sessions WHERE provider = 'codex' AND status = 'active'"
    ),
    complete: db.prepare(
      "UPDATE sessions SET status = 'completed', ended_at = @ended_at, updated_at = @updated_at WHERE id = @id"
    ),
  };
  return sweepStmts;
}

/** Upsert one parsed rollout. Returns "created" | "updated" | null. */
function upsertCodexSession(dbModule, parsed) {
  const s = getStmts(dbModule);
  const id = SESSION_ID_PREFIX + parsed.id;
  const live = parsed.mtimeMs && Date.now() - parsed.mtimeMs < ACTIVE_WINDOW_MS;
  const mtimeIso = parsed.mtimeMs ? new Date(parsed.mtimeMs).toISOString() : null;
  const row = {
    id,
    name: parsed.name,
    status: live ? "active" : "completed",
    cwd: parsed.cwd,
    model: parsed.model,
    started_at: parsed.startedAt,
    ended_at: live ? null : mtimeIso,
    updated_at: mtimeIso || parsed.startedAt || new Date().toISOString(),
    metadata: JSON.stringify({
      source: "codex",
      rolloutPath: parsed.rolloutPath,
      git: parsed.git || null,
      cliVersion: parsed.cliVersion || null,
      tokens: parsed.tokens || null,
      messages: parsed.messages,
      threadId: parsed.id,
      steering: "app-server",
      readOnly: false, // AB2 can resume/steer through native app-server
    }),
  };
  const existing = s.get.get(id);
  if (existing) {
    s.update.run(row);
    return "updated";
  }
  s.insert.run(row);
  return "created";
}

// mtime fingerprint per rollout path so an unchanged file costs one stat.
const lastSeen = new Map();

/**
 * One full sweep: parse changed rollouts, upsert them, and complete any
 * previously-active Codex session whose file has gone stale. Broadcasts
 * session_created/session_updated so the existing UI live-refresh paths fire.
 * Never throws; returns counts for logging/tests.
 */
function sweepCodexSessions(dbModule, broadcast) {
  const dir = codexSessionsDir();
  const result = { scanned: 0, created: 0, updated: 0, completed: 0 };
  if (!fs.existsSync(dir)) return result;

  for (const file of listRolloutFiles(dir)) {
    result.scanned += 1;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // Re-visit unchanged-but-live files so active→completed flips below; skip
    // unchanged completed ones entirely.
    const seen = lastSeen.get(file);
    if (seen === mtime && Date.now() - mtime > ACTIVE_WINDOW_MS + 60_000) continue;
    lastSeen.set(file, mtime);
    try {
      const parsed = parseRolloutFile(file);
      if (!parsed) continue;
      const change = upsertCodexSession(dbModule, parsed);
      if (change) {
        result[change] += 1;
        emit(
          dbModule,
          broadcast,
          change === "created" ? "session_created" : "session_updated",
          SESSION_ID_PREFIX + parsed.id
        );
      }
    } catch {
      /* one bad rollout must not abort the sweep */
    }
  }

  // Staleness pass: flip live rows whose file stopped changing to completed.
  try {
    const s = getStmts(dbModule);
    for (const row of s.activeRows.all()) {
      let rolloutPath = null;
      try {
        rolloutPath = JSON.parse(row.metadata || "{}").rolloutPath;
      } catch {
        /* ignore */
      }
      let mtimeMs = 0;
      try {
        if (rolloutPath) mtimeMs = fs.statSync(rolloutPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (!mtimeMs || Date.now() - mtimeMs >= ACTIVE_WINDOW_MS) {
        const endedIso = mtimeMs ? new Date(mtimeMs).toISOString() : new Date().toISOString();
        s.complete.run({ id: row.id, ended_at: endedIso, updated_at: endedIso });
        result.completed += 1;
        emit(dbModule, broadcast, "session_updated", row.id);
      }
    }
  } catch {
    /* fail-safe */
  }

  return result;
}

function emit(dbModule, broadcast, type, id) {
  if (typeof broadcast !== "function") return;
  try {
    const row = dbModule.stmts.getSession.get(id);
    if (row) broadcast(type, row);
  } catch {
    /* best-effort */
  }
}

// ── Usage summary (Analytics card / home usage story) ───────────────────────

/**
 * Aggregate Codex usage from the ingested rows' metadata. Honest boundary:
 * rollouts carry token counts but NOT the 5-hour/weekly limit window (no
 * `codex status --json` yet - openai/codex#10233), so `limitWindow` is the
 * literal string "unknown". The card leaves the slot for when it ships.
 */
function usageSummary(dbModule) {
  const out = {
    configured: fs.existsSync(codexSessionsDir()),
    sessions: 0,
    active: 0,
    tokens: { input: 0, cachedInput: 0, output: 0, total: 0 },
    byDay: [],
    lastActivity: null,
    limitWindow: "unknown",
  };
  let rows = [];
  try {
    rows = dbModule.db
      .prepare(
        "SELECT status, started_at, updated_at, metadata FROM sessions WHERE provider = 'codex'"
      )
      .all();
  } catch {
    return out;
  }
  const byDay = new Map();
  for (const r of rows) {
    out.sessions += 1;
    if (r.status === "active") out.active += 1;
    if (r.updated_at && (!out.lastActivity || r.updated_at > out.lastActivity)) {
      out.lastActivity = r.updated_at;
    }
    let meta = null;
    try {
      meta = JSON.parse(r.metadata || "{}");
    } catch {
      meta = null;
    }
    const t = meta && meta.tokens;
    if (t) {
      out.tokens.input += t.input || 0;
      out.tokens.cachedInput += t.cachedInput || 0;
      out.tokens.output += t.output || 0;
      out.tokens.total += t.total || 0;
      const day = String(r.started_at || "").slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + (t.total || 0));
    }
  }
  out.byDay = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([date, total]) => ({ date, total }));
  return out;
}

// ── Watcher (immediacy between scheduler ticks) ─────────────────────────────

let started = false;
let timer = null;
const watchers = [];

function startCodexWatcher({ dbModule, broadcast }) {
  if (started) return;
  started = true;
  const dir = codexSessionsDir();
  if (!fs.existsSync(dir)) return; // sweep() keeps checking; watcher armed next boot
  try {
    // Recursive fs.watch is native on macOS/Windows. The sessions tree is
    // low-churn (one growing JSONL per live session), so unlike ~/.claude this
    // is safe to watch whole; errors are swallowed - the poll is the backstop.
    const w = fs.watch(dir, { recursive: true }, () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          sweepCodexSessions(dbModule, broadcast);
        } catch {
          /* fail-safe */
        }
      }, DEBOUNCE_MS);
    });
    w.on("error", () => {});
    watchers.push(w);
  } catch {
    /* platform limitation - poll still covers it */
  }
}

function stopCodexWatcher() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers.length = 0;
  lastSeen.clear();
  sweepStmts = null;
  started = false;
}

module.exports = {
  codexSessionsDir,
  parseRolloutFile,
  parseRolloutFilename,
  listRolloutFiles,
  sweepCodexSessions,
  upsertCodexSession,
  usageSummary,
  startCodexWatcher,
  stopCodexWatcher,
  ACTIVE_WINDOW_MS,
  SESSION_ID_PREFIX,
};
