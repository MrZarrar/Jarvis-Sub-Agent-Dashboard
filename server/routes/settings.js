/**
 * @file Express router for settings-related endpoints, providing system info, database statistics, hook status, and operations to clear data, re-import sessions, reinstall hooks, reset pricing, export data, and perform cleanup of stale sessions. This allows the frontend to manage and maintain the agent monitoring system effectively.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { db, stmts, DB_PATH, DEFAULT_PRICING, applyIntroPricing } = require("../db");
const { getConnectionCount } = require("../websocket");
const { transcriptCache } = require("./hooks");
const { profileDiagnostics } = require("../lib/environment-profile");

const router = Router();

const { getSettingsPath, getClaudeHome, setClaudeHome } = require("../lib/claude-home");
const CLAUDE_SETTINGS_PATH = getSettingsPath();

function getDbSize() {
  try {
    const stat = fs.statSync(DB_PATH);
    return stat.size;
  } catch {
    return 0;
  }
}

function getTableCounts() {
  const tables = ["sessions", "agents", "events", "model_pricing"];
  const counts = {};
  for (const t of tables) {
    counts[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
  }
  counts.token_usage = db
    .prepare("SELECT COUNT(DISTINCT session_id) as c FROM token_usage")
    .get().c;
  return counts;
}

function getHookStatus() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return { installed: false, path: CLAUDE_SETTINGS_PATH, hooks: {} };
    }
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const hookTypes = [
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
      "Notification",
      "SessionStart",
      "SessionEnd",
    ];
    const hooks = {};
    for (const ht of hookTypes) {
      const entries = settings.hooks?.[ht] || [];
      hooks[ht] = entries.some(
        (e) =>
          (e.command && e.command.includes("hook-handler.js")) ||
          (Array.isArray(e.hooks) &&
            e.hooks.some((h) => h.command && h.command.includes("hook-handler.js")))
      );
    }
    const installed = Object.values(hooks).every(Boolean);
    return { installed, path: CLAUDE_SETTINGS_PATH, hooks };
  } catch {
    return { installed: false, path: CLAUDE_SETTINGS_PATH, hooks: {} };
  }
}

// GET /api/settings/info - system info, db stats, hook status
router.get("/info", (req, res) => {
  const dbSize = getDbSize();
  const counts = getTableCounts();
  const hookStatus = getHookStatus();

  // Advanced SQLite info
  const pragmas = {
    journal_mode: db.pragma("journal_mode", { simple: true }),
    synchronous: db.pragma("synchronous", { simple: true }),
    auto_vacuum: db.pragma("auto_vacuum", { simple: true }),
    encoding: db.pragma("encoding", { simple: true }),
    foreign_keys: db.pragma("foreign_keys", { simple: true }),
    busy_timeout: db.pragma("busy_timeout", { simple: true }),
  };

  // Recent activity load (events in last 5, 15, 60 minutes)
  const getCount = (ms) => {
    const d = new Date(Date.now() - ms).toISOString();
    return db.prepare("SELECT COUNT(*) as c FROM events WHERE created_at > ?").get(d).c;
  };

  const load_stats = {
    m5: getCount(5 * 60 * 1000),
    m15: getCount(15 * 60 * 1000),
    h1: getCount(60 * 60 * 1000),
  };

  res.json({
    environment: profileDiagnostics({ dbPath: DB_PATH }),
    db: {
      path: DB_PATH,
      size: dbSize,
      counts,
      pragmas,
      load_stats,
    },
    hooks: hookStatus,
    server: {
      uptime: process.uptime(),
      node_version: process.version,
      platform: process.platform,
      ws_connections: getConnectionCount(),
      memory: process.memoryUsage(),
      cpu_load: os.loadavg(),
      arch: os.arch(),
      total_mem: os.totalmem(),
      free_mem: os.freemem(),
      cpus: os.cpus().length,
    },
    transcript_cache: transcriptCache.stats(),
  });
});

// POST /api/settings/clear-data - delete all sessions, agents, events, tokens
router.post("/clear-data", (_req, res) => {
  const counts = getTableCounts();
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM token_usage").run();
  db.prepare("DELETE FROM events").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM sessions").run();
  // Fired alerts reference the cleared sessions - wipe the feed too. Alert
  // *rules* survive: they're user configuration, like model_pricing.
  db.prepare("DELETE FROM alert_events").run();
  // Webhook delivery log is an audit trail of those fired alerts - wipe it too.
  // Webhook *targets* survive, like alert rules and pricing.
  db.prepare("DELETE FROM webhook_deliveries").run();
  db.pragma("foreign_keys = ON");
  res.json({ ok: true, cleared: counts });
});

// POST /api/settings/reimport - re-import legacy sessions from ~/.claude/
router.post("/reimport", async (_req, res) => {
  try {
    const { importAllSessions } = require("../../scripts/import-history");
    const dbModule = require("../db");
    const result = await importAllSessions(dbModule);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      error: { code: "IMPORT_FAILED", message: err.message },
    });
  }
});

// POST /api/settings/reinstall-hooks - reinstall Claude Code hooks
router.post("/reinstall-hooks", (_req, res) => {
  try {
    const { installHooks } = require("../../scripts/install-hooks");
    const success = installHooks(true);
    const hookStatus = getHookStatus();
    res.json({ ok: success, hooks: hookStatus });
  } catch (err) {
    res.status(500).json({
      error: { code: "HOOK_INSTALL_FAILED", message: err.message },
    });
  }
});

// POST /api/settings/reset-pricing - reset pricing to defaults
router.post("/reset-pricing", (_req, res) => {
  db.prepare("DELETE FROM model_pricing").run();

  const seedPricing = db.prepare(
    "INSERT OR IGNORE INTO model_pricing (model_pattern, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok, fast_input_per_mtok, fast_output_per_mtok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const [pattern, name, inp, out, cr, cw, cw1h, fin, fout] of DEFAULT_PRICING) {
    seedPricing.run(pattern, name, inp, out, cr, cw, cw1h, fin, fout);
  }
  // Re-apply time-limited intro rates (e.g. Sonnet 5) - the seed above only
  // carries standard rates, so without this a reset silently drops the promo.
  applyIntroPricing(db);

  const pricing = stmts.listPricing.all();
  res.json({ ok: true, pricing });
});

// GET /api/settings/export - export all data as JSON
router.get("/export", (_req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all();
  const agents = db.prepare("SELECT * FROM agents ORDER BY started_at DESC").all();
  const events = db.prepare("SELECT * FROM events ORDER BY created_at DESC").all();
  const tokenUsage = db.prepare("SELECT * FROM token_usage").all();
  const pricing = stmts.listPricing.all();

  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="agent-monitor-export-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json({
    exported_at: new Date().toISOString(),
    sessions,
    agents,
    events,
    token_usage: tokenUsage,
    model_pricing: pricing,
  });
});

// GET /api/settings/claude-home - get current CLAUDE_HOME path
router.get("/claude-home", (_req, res) => {
  res.json({ claude_home: getClaudeHome() });
});

// PUT /api/settings/claude-home - update CLAUDE_HOME path
router.put("/claude-home", (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || typeof newPath !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_PATH", message: "path is required and must be a string" },
    });
  }
  try {
    const resolved = setClaudeHome(newPath);
    res.json({ ok: true, claude_home: resolved });
  } catch (err) {
    res.status(400).json({
      error: { code: "INVALID_PATH", message: err.message },
    });
  }
});

// ── Assistant file-access roots (Phase M, §3.1) ─────────────────────────────
// The allowlist that scopes the assistant's read_file/write_file/list_dir/shell
// file access. EMPTY BY DEFAULT - the assistant has no filesystem access until
// the user grants a root here. Stored as a JSON array in app_settings.
const ASSISTANT_ROOTS_KEY = "assistant_allowed_roots";

router.get("/assistant-roots", (_req, res) => {
  let roots = [];
  try {
    const row = stmts.getSetting.get(ASSISTANT_ROOTS_KEY);
    if (row && typeof row.value === "string" && row.value.trim()) roots = JSON.parse(row.value);
  } catch {
    roots = [];
  }
  res.json({ roots: Array.isArray(roots) ? roots : [] });
});

router.put("/assistant-roots", (req, res) => {
  const roots = req.body && req.body.roots;
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== "string")) {
    return res.status(400).json({
      error: { code: "INVALID_ROOTS", message: "roots must be an array of path strings" },
    });
  }
  const cleaned = roots.map((r) => r.trim()).filter(Boolean);
  stmts.setSetting.run(ASSISTANT_ROOTS_KEY, JSON.stringify(cleaned));
  res.json({ ok: true, roots: cleaned });
});

// ── Assistant autonomy: the `claude_agent` delegate level ───────────────────
// "off" (default) | "ask" (one-tap confirm) | "auto" (fires inline, no tap).
const ASSISTANT_AUTONOMY_KEY = "assistant_autonomy";
const AUTONOMY_LEVELS = ["off", "ask", "auto"];

router.get("/assistant-autonomy", (_req, res) => {
  let level = "off";
  try {
    const row = stmts.getSetting.get(ASSISTANT_AUTONOMY_KEY);
    if (row && typeof row.value === "string" && AUTONOMY_LEVELS.includes(row.value.trim())) {
      level = row.value.trim();
    }
  } catch {
    level = "off";
  }
  res.json({ level });
});

router.put("/assistant-autonomy", (req, res) => {
  const level = req.body && typeof req.body.level === "string" ? req.body.level.trim() : "";
  if (!AUTONOMY_LEVELS.includes(level)) {
    return res.status(400).json({
      error: {
        code: "INVALID_LEVEL",
        message: `level must be one of ${AUTONOMY_LEVELS.join(", ")}`,
      },
    });
  }
  stmts.setSetting.run(ASSISTANT_AUTONOMY_KEY, level);
  res.json({ ok: true, level });
});

// ── Browse opt-in: make read-only computer-use navigation "safe" (Phase Z) ──
// Default false → the `browse` action is risk "confirm" (one tap in the popup).
// true → read-only navigation fires inline (Tabby/Siri can drive it).
const ASSISTANT_BROWSE_KEY = "assistant_browse_safe";

router.get("/browse-safe", (_req, res) => {
  let safe = false;
  try {
    const row = stmts.getSetting.get(ASSISTANT_BROWSE_KEY);
    safe = !!(row && String(row.value).trim() === "true");
  } catch {
    safe = false;
  }
  res.json({ safe });
});

router.put("/browse-safe", (req, res) => {
  const safe = req.body && req.body.safe;
  if (typeof safe !== "boolean") {
    return res.status(400).json({
      error: { code: "INVALID_SAFE", message: "safe must be a boolean" },
    });
  }
  stmts.setSetting.run(ASSISTANT_BROWSE_KEY, safe ? "true" : "false");
  res.json({ ok: true, safe });
});

// ── Computer-use opt-in: make real-desktop click/type "safe" (Phase Z Tier 2) ─
// Default false → the `computer_use` action is risk "confirm" (one tap).
// true → it fires inline (Tabby/Siri can drive the real desktop unattended).
const ASSISTANT_COMPUTER_USE_KEY = "assistant_computer_use_safe";

router.get("/computer-use-safe", (_req, res) => {
  let safe = false;
  try {
    const row = stmts.getSetting.get(ASSISTANT_COMPUTER_USE_KEY);
    safe = !!(row && String(row.value).trim() === "true");
  } catch {
    safe = false;
  }
  res.json({ safe });
});

router.put("/computer-use-safe", (req, res) => {
  const safe = req.body && req.body.safe;
  if (typeof safe !== "boolean") {
    return res.status(400).json({
      error: { code: "INVALID_SAFE", message: "safe must be a boolean" },
    });
  }
  stmts.setSetting.run(ASSISTANT_COMPUTER_USE_KEY, safe ? "true" : "false");
  res.json({ ok: true, safe });
});

// ── Feed verbosity (Phase AF, §1/§4) ────────────────────────────────────────
// "agent" (default) → ambient surfaces (home Operations feed, ActivityFeed)
// collapse per-tool envelopes behind expandable agent rows and hide the noisier
// home instruments. "tool" → the old firehose. Debugging surfaces
// (Run/SessionDetail) always stay verbose regardless of this setting.
const VERBOSITY_KEY = "ui_verbosity";
const VERBOSITY_LEVELS = ["agent", "tool"];

router.get("/verbosity", (_req, res) => {
  let level = "agent";
  try {
    const row = stmts.getSetting.get(VERBOSITY_KEY);
    if (row && typeof row.value === "string" && VERBOSITY_LEVELS.includes(row.value.trim())) {
      level = row.value.trim();
    }
  } catch {
    level = "agent";
  }
  res.json({ level });
});

router.put("/verbosity", (req, res) => {
  const level = req.body && typeof req.body.level === "string" ? req.body.level.trim() : "";
  if (!VERBOSITY_LEVELS.includes(level)) {
    return res.status(400).json({
      error: {
        code: "INVALID_LEVEL",
        message: `level must be one of ${VERBOSITY_LEVELS.join(", ")}`,
      },
    });
  }
  stmts.setSetting.run(VERBOSITY_KEY, level);
  res.json({ ok: true, level });
});

// ── HUD mode / persona variant (Phase N, §3.3) ──────────────────────────────
// The server learns the HUD mode the client is showing so brain-composed copy
// (assistant, briefings, nudges) wears the matching persona voice. The client
// PUTs its *effective* mode here whenever it flips (Settings toggle, incantation,
// or an auto-trigger), and the `set_hud_mode` action writes it too. Stored in
// app_settings.hud_mode via the persona module (single owner of the variant).
const persona = require("../lib/brain/persona");

router.get("/hud-mode", (_req, res) => {
  res.json({ hud_mode: persona.getHudMode(), variant: persona.variant() });
});

router.put("/hud-mode", (req, res) => {
  const mode = req.body && req.body.mode;
  if (mode !== "jarvis" && mode !== "ultron" && mode !== "auto") {
    return res.status(400).json({
      error: { code: "INVALID_MODE", message: "mode must be jarvis, ultron, or auto" },
    });
  }
  const stored = persona.setHudMode(mode);
  res.json({ ok: true, hud_mode: stored, variant: persona.variant() });
});

// POST /api/settings/cleanup - abandon stale sessions, purge old data
router.post("/cleanup", (req, res) => {
  const { abandon_hours, purge_days } = req.body;
  const result = { abandoned: 0, purged_sessions: 0, purged_events: 0, purged_agents: 0 };

  if (abandon_hours && typeof abandon_hours === "number" && abandon_hours > 0) {
    // Mark active sessions with no recent events as abandoned
    const cutoff = new Date(Date.now() - abandon_hours * 3600 * 1000).toISOString();
    const stale = db
      .prepare(
        `SELECT s.id FROM sessions s
         WHERE s.status = 'active'
           AND s.started_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM events e WHERE e.session_id = s.id AND e.created_at > ?
           )`
      )
      .all(cutoff, cutoff);

    for (const row of stale) {
      db.prepare(
        "UPDATE sessions SET status = 'abandoned', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).run(row.id);
      // Also complete any lingering agents
      db.prepare(
        "UPDATE agents SET status = 'completed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND status IN ('waiting','working')"
      ).run(row.id);
    }
    result.abandoned = stale.length;
  }

  if (purge_days && typeof purge_days === "number" && purge_days > 0) {
    const cutoff = new Date(Date.now() - purge_days * 86400 * 1000).toISOString();
    // Only purge completed/error/abandoned sessions, never active
    const toDelete = db
      .prepare(
        "SELECT id FROM sessions WHERE status IN ('completed','error','abandoned') AND started_at < ?"
      )
      .all(cutoff);

    if (toDelete.length > 0) {
      const ids = toDelete.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      // Cascading deletes handle agents/events, but token_usage FK might not cascade on all setups
      result.purged_events = db
        .prepare(`DELETE FROM events WHERE session_id IN (${placeholders})`)
        .run(...ids).changes;
      result.purged_agents = db
        .prepare(`DELETE FROM agents WHERE session_id IN (${placeholders})`)
        .run(...ids).changes;
      db.prepare(`DELETE FROM token_usage WHERE session_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
      result.purged_sessions = toDelete.length;
    }
  }

  res.json({ ok: true, ...result });
});

module.exports = router;
