/**
 * @file Database setup and access layer using SQLite for storing sessions, agents, events, token usage, and model pricing. Handles schema creation, migrations, and provides prepared statements for all database operations.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  try {
    Database = require("./compat-sqlite");
  } catch {
    console.error(
      "\n" +
        "╔══════════════════════════════════════════════════════════════╗\n" +
        "║  SQLite backend not available                                ║\n" +
        "║                                                              ║\n" +
        "║  better-sqlite3 could not be loaded (native module) and      ║\n" +
        "║  node:sqlite is not available (requires Node.js >= 22).      ║\n" +
        "║                                                              ║\n" +
        "║  Fix options (pick one):                                     ║\n" +
        "║    1. Upgrade to Node.js 22+ (recommended)                   ║\n" +
        "║    2. Install Python 3 + C++ build tools, then               ║\n" +
        "║       run: npm rebuild better-sqlite3                        ║\n" +
        "╚══════════════════════════════════════════════════════════════╝\n"
    );
    process.exit(1);
  }
}
const path = require("path");
const fs = require("fs");
const { getDataDir } = require("./lib/claude-home");

/**
 * Seed `targetPath` from the richest pre-existing database when none exists
 * there yet. Best-effort and strictly non-destructive: it never overwrites the
 * target and never modifies or deletes the sources, so existing web users keep
 * an untouched backup at the old path.
 *
 * Earlier builds kept the DB per-host - the repo-local `data/` dir for
 * `npm start`/`dev`, and the desktop app's per-user `userData/data` (handed in
 * via DASHBOARD_LEGACY_DB_PATH). When both exist we copy the larger one (more
 * rows ≈ larger file) so the fuller history wins.
 */
function migrateLegacyDatabase(targetPath) {
  try {
    // Respect explicit overrides: if the operator pinned the path, they own it.
    if (process.env.DASHBOARD_DB_PATH || process.env.DASHBOARD_DATA_DIR) return;
    if (fs.existsSync(targetPath)) return; // already migrated, or in active use

    const candidates = [
      process.env.DASHBOARD_LEGACY_DB_PATH, // desktop app's old per-user DB
      path.join(__dirname, "..", "data", "dashboard.db"), // repo-local `npm start` DB
    ].filter((p) => p && fs.existsSync(p));
    if (candidates.length === 0) return;

    const source = candidates
      .map((p) => ({ p, size: fs.statSync(p).size }))
      .sort((a, b) => b.size - a.size)[0].p;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // `VACUUM INTO` produces a consistent, fully-checkpointed single-file copy -
    // safe even when another process still holds the source open in WAL mode,
    // and it never touches the source. A raw file copy of a live WAL database,
    // by contrast, can capture an inconsistent .db/-wal/-shm trio and yield a
    // "database disk image is malformed" file, so we deliberately do NOT fall
    // back to one. `VACUUM INTO` ships in every SQLite the project uses (3.27+:
    // better-sqlite3 and node:sqlite both support it).
    const src = new Database(source);
    try {
      src.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }

    // Carry over the one-time legacy-import marker so the (idempotent) backfill
    // doesn't needlessly re-run against the migrated copy.
    const srcMarker = path.join(path.dirname(source), ".legacy-import.done");
    const dstMarker = path.join(path.dirname(targetPath), ".legacy-import.done");
    if (fs.existsSync(srcMarker) && !fs.existsSync(dstMarker)) {
      try {
        fs.copyFileSync(srcMarker, dstMarker);
      } catch {
        /* non-fatal */
      }
    }

    console.log(`[db] migrated existing database → ${targetPath} (from ${source})`);
  } catch (err) {
    // Migration is an optimization, never a hard requirement. On any failure,
    // remove a possibly-partial target so the next start retries (or falls back
    // to a fresh empty DB) instead of opening a half-written, corrupt file. The
    // source is never modified, so nothing is lost.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(targetPath + suffix, { force: true });
      } catch {
        /* best effort */
      }
    }
    console.warn("[db] legacy database migration skipped:", err?.message || err);
  }
}

// Resolution order: explicit DASHBOARD_DB_PATH wins; otherwise the file lives in
// the shared data dir - DASHBOARD_DATA_DIR if set, else the canonical user-global
// `~/.claude/agent-dashboard/` (see getDataDir). Resolving every launch path to
// the same file is what lets the web app and the native apps share ONE database.
const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(getDataDir(), "dashboard.db");
const DB_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DB_DIR, { recursive: true });

// One-time, non-destructive migration into the shared location. Earlier builds
// kept the database per-host: the repo-local `data/` dir for `npm start`/`dev`,
// and the desktop app's per-user `userData/data` (handed to us via
// DASHBOARD_LEGACY_DB_PATH). If the canonical DB doesn't exist yet, seed it from
// the richest legacy copy found so existing users keep all their history. The
// source files are never modified or deleted, and an existing canonical DB is
// never overwritten - so this is safe to run on every startup.
migrateLegacyDatabase(DB_PATH);

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','error','abandoned')),
    cwd TEXT,
    model TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'main' CHECK(type IN ('main','subagent')),
    subagent_type TEXT,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('working','waiting','completed','error')),
    task TEXT,
    current_tool TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    parent_agent_id TEXT,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    summary TEXT,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'unknown',
    -- Pricing dimensions: tokens are bucketed by these because each changes the
    -- per-token RATE (fast mode, US data residency, Batch API). Defaults match
    -- the standard/global/standard rate so historical rows price unchanged.
    speed TEXT NOT NULL DEFAULT 'standard',
    inference_geo TEXT NOT NULL DEFAULT 'global',
    service_tier TEXT NOT NULL DEFAULT 'standard',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    -- Subset of cache_write_tokens stored at the 1h tier; 5m = total - 1h.
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    -- Server-tool request counts (billed separately from tokens).
    web_search_requests INTEGER NOT NULL DEFAULT 0,
    web_fetch_requests INTEGER NOT NULL DEFAULT 0,
    code_execution_requests INTEGER NOT NULL DEFAULT 0,
    -- Compaction baselines preserve pre-rewrite totals (effective = current + baseline).
    baseline_input INTEGER NOT NULL DEFAULT 0,
    baseline_output INTEGER NOT NULL DEFAULT 0,
    baseline_cache_read INTEGER NOT NULL DEFAULT 0,
    baseline_cache_write INTEGER NOT NULL DEFAULT 0,
    baseline_cache_write_1h INTEGER NOT NULL DEFAULT 0,
    baseline_web_search INTEGER NOT NULL DEFAULT 0,
    baseline_web_fetch INTEGER NOT NULL DEFAULT 0,
    baseline_code_execution INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model, speed, inference_geo, service_tier),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_pricing (
    model_pattern TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    input_per_mtok REAL NOT NULL DEFAULT 0,
    output_per_mtok REAL NOT NULL DEFAULT 0,
    cache_read_per_mtok REAL NOT NULL DEFAULT 0,
    cache_write_per_mtok REAL NOT NULL DEFAULT 0,
    cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0,
    -- Fast mode (research preview) premium input/output rates; 0 = no fast pricing.
    -- Cache rates in fast mode are derived from fast_input via the standard
    -- caching multipliers (see server/lib/pricing-constants.js).
    fast_input_per_mtok REAL NOT NULL DEFAULT 0,
    fast_output_per_mtok REAL NOT NULL DEFAULT 0,
    -- Time-limited introductory rates. When intro_until is set, usage on/before
    -- that date (YYYY-MM-DD) is priced at the intro_* rates and usage after it at
    -- the standard rates - so promo pricing (e.g. Claude Sonnet 5's launch
    -- discount through 2026-08-31) stays correct for historical and future usage
    -- at all times. 0 / NULL means "no intro rate" → standard rates always apply.
    intro_input_per_mtok REAL NOT NULL DEFAULT 0,
    intro_output_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_read_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_write_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0,
    intro_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Per-category push delivery switches, stored server-side so a category can be
  -- silenced for ALL devices from any device (unlike the localStorage client
  -- notification prefs, which are per-browser). Rows are created lazily by the
  -- push router's category endpoints; a category with no row defaults to ON, so
  -- server-originated pushes (permission requests today; run completions,
  -- waiting agents, and briefings as later phases land) fire unless explicitly
  -- muted here. See isCategoryEnabled in server/lib/push.js.
  CREATE TABLE IF NOT EXISTS notification_prefs (
    category TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Persistent record of every agent run spawned via the dashboard's
  -- /api/run endpoint. Survives the in-memory handle reap so the Run page
  -- can list completed / errored / killed runs and offer Resume long after
  -- the spawner has forgotten about them.
  CREATE TABLE IF NOT EXISTS dashboard_runs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'claude',
    session_id TEXT,
    mode TEXT NOT NULL,
    cwd TEXT NOT NULL,
    model TEXT,
    permission_mode TEXT,
    effort TEXT,
    resume_session_id TEXT,
    prompt_preview TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT
  );

  -- Provider-neutral Agentic OS envelope. Provider-native ids stay linkable,
  -- while lifecycle, routing, approvals, artifacts, and presentation remain
  -- owned by Jarvis.
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    domain TEXT NOT NULL,
    interaction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    owner_provider TEXT NOT NULL,
    worker_provider TEXT,
    owner_model_tier TEXT NOT NULL,
    resolved_model TEXT,
    native_thread_id TEXT,
    active_turn_id TEXT,
    parent_mission_id TEXT,
    workspace TEXT,
    origin TEXT NOT NULL DEFAULT 'desktop',
    approval_policy TEXT NOT NULL DEFAULT 'on-request',
    sandbox_policy TEXT NOT NULL DEFAULT 'read-only',
    routing_reason TEXT,
    run_id TEXT,
    schedule_id TEXT,
    usage_summary TEXT NOT NULL DEFAULT '{}',
    result_summary TEXT,
    artifact_links TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (parent_mission_id) REFERENCES missions(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS mission_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    event TEXT NOT NULL,
    summary TEXT,
    native TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mission_links (
    id TEXT PRIMARY KEY,
    parent_mission_id TEXT NOT NULL,
    child_mission_id TEXT,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    native_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    result_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (parent_mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (child_mission_id) REFERENCES missions(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS mission_approvals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_request_id TEXT NOT NULL,
    method TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    decision TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mission_artifacts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    label TEXT,
    native_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    UNIQUE (mission_id, provider, kind, uri, native_id)
  );

  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

  -- Composite indexes for frequent query patterns (columns that exist at table creation time)
  CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);
  -- Subagent JSONL import dedups each tool event with
  -- "WHERE agent_id = ? AND event_type = ? AND data LIKE '%tool_use_id%'".
  -- Without an agent_id index that is a full events-table scan per tool event;
  -- on a large DB a single re-import (e.g. the startup sync sweep re-touching a
  -- session with many subagents) becomes tens of seconds and blocks the event
  -- loop. This composite narrows each dedup to the agent's events of that type.
  CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_agents_session_type ON agents(session_id, type);
  CREATE INDEX IF NOT EXISTS idx_dashboard_runs_started ON dashboard_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dashboard_runs_session ON dashboard_runs(session_id);
  CREATE INDEX IF NOT EXISTS idx_missions_status_updated ON missions(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_missions_thread ON missions(native_thread_id);
  CREATE INDEX IF NOT EXISTS idx_missions_parent ON missions(parent_mission_id);
  CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events(mission_id, id);
  CREATE INDEX IF NOT EXISTS idx_mission_links_parent ON mission_links(parent_mission_id);
  CREATE INDEX IF NOT EXISTS idx_mission_approvals_mission ON mission_approvals(mission_id, status);
  CREATE INDEX IF NOT EXISTS idx_mission_artifacts_mission ON mission_artifacts(mission_id, created_at);

  -- Rules-based alerting engine. Rules are evaluated server-side: event-driven
  -- types (event_pattern, token_threshold) on hook ingest, time-based types
  -- (inactivity, status_duration) on a periodic sweep in server/lib/alerts.js.
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('event_pattern','inactivity','status_duration','token_threshold')),
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_seconds INTEGER NOT NULL DEFAULT 300,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Fired alerts. rule_name/rule_type are snapshotted so history stays
  -- readable after a rule is edited. session_id intentionally has no FK:
  -- alerts are an audit trail and must survive session cleanup.
  CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    session_id TEXT,
    agent_id TEXT,
    message TEXT NOT NULL,
    details TEXT,
    triggered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    acknowledged_at TEXT,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_alert_events_triggered ON alert_events(triggered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events(rule_id);
  CREATE INDEX IF NOT EXISTS idx_alert_events_session ON alert_events(session_id);

  -- Universal webhook delivery for fired alerts. A target is an outbound
  -- destination (Slack / Discord / Teams / any generic HTTP endpoint). When an
  -- alert fires, server/lib/webhooks.js formats a per-platform payload and
  -- POSTs it to every enabled target (optionally scoped to specific rules).
  -- Targets are user configuration and survive Clear Data, like alert_rules.
  CREATE TABLE IF NOT EXISTS webhook_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- provider key (slack, discord, teams, telegram, pagerduty, …). Not a DB
    -- CHECK: the provider registry in server/lib/webhook-providers.js is the
    -- single source of truth and the route validates against it, so a CHECK
    -- here would just be a second list to keep in sync.
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    -- optional HMAC-SHA256 signing secret (generic targets): when set, the raw
    -- request body is signed and sent as X-Webhook-Signature.
    secret TEXT,
    -- optional JSON object of extra request headers (generic targets only).
    headers TEXT,
    -- optional JSON array of alert_rule ids this target is scoped to. NULL or
    -- empty array means "all rules".
    rule_ids TEXT,
    -- optional JSON object of provider-specific config (e.g. Telegram chat_id,
    -- PagerDuty routing_key, Opsgenie api_key + region). Schema is per-provider
    -- and lives in server/lib/webhook-providers.js. Secret fields are redacted
    -- in API responses.
    config TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Delivery audit log: one row per completed delivery attempt-chain. alert_id
  -- intentionally has no FK (like alert_events.session_id) - deliveries are an
  -- audit trail and the referenced alert may be wiped by Clear Data. NULL
  -- alert_id marks a manual "Send test" ping.
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    target_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    alert_id INTEGER,
    status TEXT NOT NULL CHECK(status IN ('success','failed')),
    status_code INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (target_id) REFERENCES webhook_targets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_target ON webhook_deliveries(target_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);

  -- Workflow-tool runs: fleets of sub-agents spawned by the Claude Code
  -- "Workflow" tool (and self-paced /loop). These emit NO hooks; the source of
  -- truth is the on-disk run journal (~/.claude/projects/<enc-cwd>/<sessionId>/
  -- workflows/wf_<runId>.json), written at workflow COMPLETION. A row is keyed
  -- by run_id, parented to the launching session. status is an open string
  -- (running | completed | error | failed | …) - intentionally no CHECK, so new
  -- harness states never trip a stale constraint. phases/progress hold the
  -- journal's phases[] / workflowProgress[] arrays verbatim (JSON) for detail
  -- rendering; the inner agents are linked via agents.workflow_run_id.
  CREATE TABLE IF NOT EXISTS workflows (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    default_model TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    agent_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_tool_calls INTEGER NOT NULL DEFAULT 0,
    phases TEXT,
    progress TEXT,
    script_path TEXT,
    journal_path TEXT,
    source TEXT NOT NULL DEFAULT 'journal',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_session ON workflows(session_id);
  CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);

  -- Multi-account tracking (Phase K). The user runs two Claude accounts via
  -- claude-swap (https://github.com/realiti4/claude-swap), which swaps accounts
  -- in place under a single ~/.claude. The dashboard observes claude-swap's
  -- state files READ-ONLY (server/lib/claude-swap.js) and records the identities
  -- it sees here. id is the account key claude-swap uses (email/label);
  -- active flags the account currently in use. Everything degrades gracefully:
  -- with no claude-swap present these tables simply stay empty and the rest of
  -- the dashboard behaves exactly as a single implicit account.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_active TEXT,
    -- Best-effort per-account window/reset info parsed from claude-swap state,
    -- when it exposes it (nullable - often unknown for the inactive account).
    resets_at TEXT,
    metadata TEXT
  );

  -- Swap history: one row per observed active-account transition. from_account
  -- is null for the very first observation (we can't know the prior account).
  CREATE TABLE IF NOT EXISTS account_swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_account TEXT,
    to_account TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_account_swaps_created ON account_swaps(created_at DESC);

  -- Scheduled & chained prompts (Phase L). Each row is one deferred spawn or
  -- follow-up message. trigger_kind is 'at' (fire at a timestamp) or
  -- 'on_run_complete' (fire when a watched run reaches a terminal status).
  -- target_kind is 'new_run' (spawn a fresh claude run with the captured
  -- spawn opts) or 'session_message' (deliver the prompt into a live run via the
  -- existing /api/run/:id/message path). Spawn opts + trigger params are stored
  -- as JSON so the scheduler can re-arm across restarts with zero extra columns.
  -- This is THE shared scheduler G2 (daily brain task) and H5 (skill cron) reuse.
  CREATE TABLE IF NOT EXISTS scheduled_prompts (
    id TEXT PRIMARY KEY,
    label TEXT,
    prompt TEXT NOT NULL,
    target_kind TEXT NOT NULL DEFAULT 'new_run',
    -- JSON: for new_run { cwd, model, mode, permissionMode, permissionUx, effort };
    --       for session_message { runId }.
    target_opts TEXT NOT NULL DEFAULT '{}',
    trigger_kind TEXT NOT NULL DEFAULT 'at',
    -- For trigger_kind='at': ISO timestamp. NULL for on_run_complete.
    fire_at TEXT,
    -- For trigger_kind='on_run_complete': the run id we watch.
    trigger_run_id TEXT,
    -- 'any' | 'success' - success only fires when the watched run exits cleanly.
    status_filter TEXT NOT NULL DEFAULT 'any',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fired','cancelled','failed')),
    -- Chain-depth guard: a fired run may itself be the trigger of another
    -- schedule; this bounds the length of such a chain (see scheduler.js).
    chain_depth INTEGER NOT NULL DEFAULT 0,
    late INTEGER NOT NULL DEFAULT 0,
    fired_at TEXT,
    result_run_id TEXT,
    -- Agentic OS scheduling fields. Old rows retain their original run target;
    -- new schedules default to provider-neutral missions.
    recurrence TEXT,
    domain TEXT NOT NULL DEFAULT 'personal',
    owner_provider TEXT,
    model_tier TEXT,
    workspace TEXT,
    agent_role TEXT,
    approval_policy TEXT NOT NULL DEFAULT 'never',
    sandbox_policy TEXT NOT NULL DEFAULT 'read-only',
    thread_strategy TEXT NOT NULL DEFAULT 'new_thread',
    notification_policy TEXT NOT NULL DEFAULT 'all',
    overlap_policy TEXT NOT NULL DEFAULT 'skip',
    missed_run_policy TEXT NOT NULL DEFAULT 'run_once',
    retry_limit INTEGER NOT NULL DEFAULT 0,
    retry_attempts INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 1800,
    current_mission_id TEXT,
    last_mission_id TEXT,
    native_thread_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_status ON scheduled_prompts(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_trigger_run ON scheduled_prompts(trigger_run_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_fire_at ON scheduled_prompts(fire_at);

  -- Voice / assistant bearer tokens (Phase D). The single POST /api/assistant/ask
  -- endpoint that powers Siri Shortcuts / CarPlay / the notes chat / quick actions
  -- authenticates with one of these long-lived tokens (generated on the Settings
  -- page; the Shortcut stores it - see server/lib/assistant-token.js and §3.3 of
  -- PLAN-jarvis-master.md). Only a SHA-256 HASH of the token is persisted - the
  -- plaintext is shown exactly once at creation, so a leaked DB never yields a
  -- usable token. token_prefix keeps the first few chars for a recognizable label
  -- in the UI. Revoking = deleting the row; verifying updates last_used_at.
  CREATE TABLE IF NOT EXISTS assistant_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used_at TEXT
  );

  -- Brain-dump inbox (Phase D → drained by the Notes system in Phase G). A voice
  -- or chat "note: …" is captured here VERBATIM so nothing is lost before Phase G
  -- exists to file it as markdown. status stays 'inbox' until Phase G processes
  -- it. This table is deliberately minimal - Phase G owns the real notes schema.
  CREATE TABLE IF NOT EXISTS assistant_captures (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assistant_captures_status ON assistant_captures(status, created_at DESC);

  -- Multi-provider chat (Phase E, §E1). A chats conversation groups ordered
  -- chat_messages. Additive + independent of every existing table. provider
  -- and model on the chat are the last-used pick (the picker seeds from them);
  -- each message also records the provider/model that produced it. cc_session_id
  -- lets the Claude provider continue one Claude Code session across turns
  -- (--resume) instead of re-sending the whole transcript. image_path is set
  -- only for generated-image messages (file lives under the data dir).
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT,
    provider TEXT,
    model TEXT,
    cc_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    provider TEXT,
    model TEXT,
    content TEXT NOT NULL DEFAULT '',
    image_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

  -- Projects (Phase F). The dashboard-native organizing dimension across
  -- sessions/runs/chats - deliberately separate from Claude.ai's own
  -- "Projects" feature, which this never talks to. status is a small closed
  -- set (no CHECK-widening migration expected: "done" covers "archived").
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done')),
    repo_path TEXT,
    notes_dir TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- A project may span more than one repo/working-directory tree, so the
  -- cwd → project match is a one-to-many table rather than a single column
  -- on projects. server/lib/projects.js does the longest-prefix match in JS
  -- (path boundary aware) since SQLite has no clean "is-ancestor-of" operator.
  CREATE TABLE IF NOT EXISTS project_paths (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_project_paths_project ON project_paths(project_id);

  -- Generic key/value app settings (Phase G). A tiny store for a handful of
  -- server-side preferences that don't warrant their own table or a config file
  -- (first user: the Notes directory). Values are opaque strings (JSON when a
  -- setting needs structure). Deliberately minimal - provider SECRETS never go
  -- here (those stay in server/config/providers.json, gitignored).
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Notes INDEX (Phase G1). The markdown files on disk are the system of record
  -- (Obsidian-compatible, agent-readable); this table is a rebuildable index a
  -- watcher keeps in sync, so an edit made anywhere shows up. The id column
  -- mirrors the file's frontmatter id; path is the absolute file path (the
  -- stable file identity). tags is a JSON array string. source is manual|dump|voice.
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    project_id TEXT,
    source TEXT,
    excerpt TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    mtime TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);

  -- Vault edge index (Phase S). The knowledge-vault graph over the notes tree:
  -- wikilinks and frontmatter relations between markdown files. Rebuildable,
  -- like the notes index. dst_key is the normalized link target (title/slug) so
  -- an unresolved link survives until its target file appears; dst_id is filled
  -- once the target exists. type: link (wikilink) | project (frontmatter).
  CREATE TABLE IF NOT EXISTS vault_edges (
    src_id TEXT NOT NULL,
    dst_key TEXT NOT NULL,
    dst_id TEXT,
    type TEXT NOT NULL DEFAULT 'link',
    PRIMARY KEY (src_id, dst_key, type)
  );

  CREATE INDEX IF NOT EXISTS idx_vault_edges_dst ON vault_edges(dst_id);
  CREATE INDEX IF NOT EXISTS idx_vault_edges_dst_key ON vault_edges(dst_key);

  -- Vault entity engine (Phase T). Entities the engine has recognized across
  -- notes. type is a free label the extractor suggests (person/project/
  -- organization/topic/place/event/technology) - no CHECK, tunable without a
  -- migration. aliases is a JSON array. note_id stays NULL until the entity is
  -- promoted (mentioned in 2+ distinct notes) and a real vault file exists for
  -- it; vault_mentions is the promotion trigger (COUNT of distinct note_ids -
  -- no counter column to keep in sync).
  CREATE TABLE IF NOT EXISTS vault_entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'topic',
    aliases TEXT NOT NULL DEFAULT '[]',
    note_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS vault_mentions (
    entity_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (entity_id, note_id)
  );

  CREATE INDEX IF NOT EXISTS idx_vault_mentions_note ON vault_mentions(note_id);

  CREATE TABLE IF NOT EXISTS vault_entity_facts (
    entity_id TEXT NOT NULL,
    source_note_id TEXT NOT NULL,
    facts TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (entity_id, source_note_id)
  );

  CREATE INDEX IF NOT EXISTS idx_vault_entity_facts_source
    ON vault_entity_facts(source_note_id);

  -- Brain-call log (Phase G2). Every mini-Jarvis routing decision records its
  -- task class, the provider that answered, whether it fell back, latency, and
  -- (when the provider reports it) token count - visibility for the Analytics
  -- page. Fail-safe: a logging failure never blocks the brain answer.
  CREATE TABLE IF NOT EXISTS brain_calls (
    id TEXT PRIMARY KEY,
    task_class TEXT,
    provider TEXT,
    intent TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    fell_back INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    tokens INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_brain_calls_created ON brain_calls(created_at DESC);

  -- Assistant action log (Phase M, §3.1). Every action the assistant executes -
  -- typed, spoken, scheduled, or LLM-tool-called - flows through the single
  -- dispatcher (server/lib/assistant-actions) and lands here: what ran, a HASH of
  -- its params (never the raw params - a shell command or file body may be
  -- sensitive), who triggered it (source), the action's risk level, and the
  -- outcome. Auditable agency; a logging failure never blocks the action.
  CREATE TABLE IF NOT EXISTS assistant_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    params_hash TEXT,
    source TEXT,
    risk TEXT,
    outcome TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assistant_actions_created ON assistant_actions(created_at DESC);

  -- Project pulse (Phase G2). One current row per project, recomputed by a daily
  -- brain task (reusing the shared scheduler): how neglected/active each project
  -- is, from last activity + open note todos + the project's status field. Feeds
  -- the Projects page, the home "Neglected" surface, and (later) Phase J briefings.
  CREATE TABLE IF NOT EXISTS project_pulse (
    project_id TEXT PRIMARY KEY,
    state TEXT,
    summary TEXT,
    days_since_activity INTEGER,
    open_todos INTEGER,
    last_activity_at TEXT,
    computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Skill runs (Phase H). Skills themselves are markdown-with-frontmatter files
  -- on disk (~/JarvisSkills, same file-first philosophy as notes) - there is no
  -- SQLite table for skill DEFINITIONS, only their execution history. trigger
  -- records who/what started the run (manual|voice|phone|schedule); voice and
  -- schedule triggers are only ever allowed to fire a confirm:none skill
  -- (enforced in server/lib/skills/engine.js, not here). steps is a JSON array
  -- of per-step progress ({index,type,label,status,output,error,startedAt,
  -- finishedAt}), appended to as the engine runs so the Skills page can render
  -- live progress and a full history afterward.
  CREATE TABLE IF NOT EXISTS skill_runs (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    skill_name TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK(trigger IN ('manual','voice','phone','schedule')),
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed','cancelled')),
    params TEXT NOT NULL DEFAULT '{}',
    steps TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_skill_runs_status ON skill_runs(status);

  -- GitHub dev-workflow panel (Phase I): a single-row snapshot cache of the
  -- latest cross-repo overview (open PRs, review requests, CI status, issues) so
  -- GET /api/github serves instantly and survives restarts. The poller refreshes
  -- it and broadcasts github_updated only when the fingerprint changes.
  CREATE TABLE IF NOT EXISTS github_cache (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    data TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT,
    fetched_at TEXT,
    error TEXT
  );

  -- Monday.com panel (Phase AD): a single-row snapshot cache of the latest
  -- overview (my items, due/overdue today, recent updates) so GET /api/monday
  -- serves instantly and survives restarts. The poller refreshes it and
  -- broadcasts monday_updated only when the fingerprint changes. Same pattern
  -- as github_cache above.
  CREATE TABLE IF NOT EXISTS monday_cache (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    data TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT,
    fetched_at TEXT,
    error TEXT
  );

  -- Proactive briefings (Phase J): a persisted history of the morning/evening
  -- briefings Jarvis composes from project pulse + GitHub + run activity. Each
  -- row keeps both the full markdown (text) and the short spoken variant
  -- (speech, read by Siri), the provider that composed it (null = deterministic
  -- fallback), and a link to the markdown note it was also filed as. The Briefings
  -- page lists these; the scheduled ticks and the "morning briefing" voice intent
  -- both write here.
  CREATE TABLE IF NOT EXISTS briefings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    trigger TEXT,
    text TEXT NOT NULL,
    speech TEXT,
    provider TEXT,
    note_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_briefings_created ON briefings(created_at DESC);

  -- Notification inbox (Phase O, §3.2). Every producer that used to fire-and-
  -- forget a web push now goes through server/lib/notify.js, which ALSO persists
  -- here so notifications have a durable in-dashboard inbox (surfaced on the
  -- Tabby ball). data is JSON: { url, ...entity ids } - the deep link plus
  -- whatever the inbox needs to render richly. dedupe_key lets the facade
  -- coalesce same-category+entity repeats into one row instead of stacking
  -- near-duplicates. read_at NULL = unread.
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    category TEXT,
    title TEXT NOT NULL,
    body TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    source TEXT,
    dedupe_key TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at TEXT
  );

  -- Subscriptions / finance tracker (Phase AE). Manual entries (plus the
  -- paste-to-parse brain assist) - deliberately NO bank/Plaid integration.
  -- next_renewal is a YYYY-MM-DD date the server rolls forward on save and on
  -- the daily finance tick (lib/finance.js owns the date math). cadence_days
  -- only applies to cadence='custom'.
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'GBP',
    cadence TEXT NOT NULL DEFAULT 'monthly' CHECK(cadence IN ('monthly','yearly','custom')),
    cadence_days INTEGER,
    next_renewal TEXT,
    category TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Server-enforced Brain PIN Lock. The PIN is stored only as a salted scrypt
  -- hash; failed attempts survive restarts. Unlock tokens are random per-device
  -- values whose SHA-256 hashes are the only form persisted in SQLite.
  CREATE TABLE IF NOT EXISTS brain_lock_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    timeout_minutes INTEGER NOT NULL DEFAULT 5 CHECK(timeout_minutes IN (1, 5, 15, 30)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS brain_unlock_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_brain_unlock_sessions_expiry
    ON brain_unlock_sessions(expires_at);
`);

// Migrate: the upstream (pre-fork) schema had a different `notifications` table
// (INTEGER id, session_id, notification_type) that CREATE TABLE IF NOT EXISTS
// above would silently keep. If the Phase-O inbox columns are missing, park the
// legacy table non-destructively and recreate the inbox shape. Indexes are
// created here (not in the big exec) so a legacy shape can't crash boot.
try {
  db.prepare("SELECT read_at, dedupe_key FROM notifications LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE notifications RENAME TO notifications_legacy").run();
  db.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      category TEXT,
      title TEXT NOT NULL,
      body TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      source TEXT,
      dedupe_key TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      read_at TEXT
    );
  `);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);
`);

// Notes full-text search (Phase G1). FTS5 is compiled into better-sqlite3's
// bundled SQLite by default, but we guard its creation so a stripped SQLite
// build never crashes boot - Notes search then degrades to a LIKE scan
// (server/lib/notes.js checks NOTES_FTS_OK). Contentless-standalone (not
// external-content) so the watcher can rebuild a row with a plain DELETE+INSERT.
let NOTES_FTS_OK = false;
try {
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, title, tags, body);"
  );
  NOTES_FTS_OK = true;
} catch {
  NOTES_FTS_OK = false;
}

// Migrate: notes created before selective access did not carry a sensitivity
// marker. Existing Markdown remains authoritative and can be reindexed; the
// default keeps legacy index rows ordinary until then.
try {
  db.prepare("SELECT sensitive FROM notes LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE notes ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0").run();
}

// Migrate: add nullable project_id to sessions, dashboard_runs, and chats
// (Phase F). Additive + nullable, so existing rows and every current query
// keep working unchanged; only new association logic reads/writes it.
try {
  db.prepare("SELECT project_id FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN project_id TEXT").run();
}
try {
  db.prepare("SELECT project_id FROM dashboard_runs LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE dashboard_runs ADD COLUMN project_id TEXT").run();
}
try {
  db.prepare("SELECT project_id FROM chats LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE chats ADD COLUMN project_id TEXT").run();
}
db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)").run();
db.prepare(
  "CREATE INDEX IF NOT EXISTS idx_dashboard_runs_project ON dashboard_runs(project_id)"
).run();
db.prepare("CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id)").run();

// Migrate: add nullable account_id to sessions and dashboard_runs so usage and
// runs can be attributed to the claude-swap account active at their start time
// (Phase K). Additive + nullable, so single-account (non-swap) setups are
// entirely unaffected - the column simply stays NULL and every existing query
// keeps working.
try {
  db.prepare("SELECT account_id FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN account_id TEXT").run();
}
try {
  db.prepare("SELECT account_id FROM dashboard_runs LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE dashboard_runs ADD COLUMN account_id TEXT").run();
}

// Migrate: retain the agent backend on persistent Run history (Phase AB2).
// Existing rows predate multi-provider runs and are therefore Claude runs.
try {
  db.prepare("SELECT provider FROM dashboard_runs LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE dashboard_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'").run();
}

// Migrate: link agent rows to a workflow run. Workflow inner-agents are already
// ingested as subagents (same subagents/ dir); these columns add the grouping +
// phase that the run journal provides. Additive, safe on existing DBs.
try {
  db.prepare("SELECT workflow_run_id FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN workflow_run_id TEXT").run();
  db.prepare("ALTER TABLE agents ADD COLUMN workflow_phase TEXT").run();
}
db.prepare("CREATE INDEX IF NOT EXISTS idx_agents_workflow ON agents(workflow_run_id)").run();

// Migrate: add the 1h-ephemeral cache-write rate column to model_pricing.
// Older DBs predate the 5m/1h cache-write split. ADD COLUMN defaults every
// existing row to 0, which is not a realistic rate - so immediately backfill a
// sensible per-model value derived from each row's own rates rather than a flat
// guess (this also covers custom user-added models, not just the defaults):
//   • 1h write ≈ 2× base input            (Anthropic's published ratio)
//   • fallback: 1.6× the 5m write rate     (since 5m ≈ 1.25× input ⇒ 1h ≈ 1.6× 5m)
//   • leave 0 only when neither input nor 5m-write is known.
// User-edited 5m/input/output/read rates are preserved untouched. The top-up
// below only inserts missing patterns, so it can't fill a new column on rows
// that already exist - this backfill is what keeps existing models complete.
try {
  db.prepare("SELECT cache_write_1h_per_mtok FROM model_pricing LIMIT 1").get();
} catch {
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    `UPDATE model_pricing
     SET cache_write_1h_per_mtok = CASE
       WHEN input_per_mtok > 0 THEN input_per_mtok * 2
       WHEN cache_write_per_mtok > 0 THEN cache_write_per_mtok * 1.6
       ELSE 0
     END
     WHERE cache_write_1h_per_mtok = 0`
  ).run();
}

// Migrate: add fast-mode (research preview) premium rate columns to model_pricing.
// Default 0 (= no fast pricing), then backfill the fast-capable Opus models on
// existing DBs with their published rates so historical configs gain fast pricing
// without a manual "Reset Defaults" (only fills rows still at 0).
try {
  db.prepare("SELECT fast_input_per_mtok FROM model_pricing LIMIT 1").get();
} catch {
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN fast_input_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN fast_output_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  const setFast = db.prepare(
    "UPDATE model_pricing SET fast_input_per_mtok = ?, fast_output_per_mtok = ? WHERE model_pattern = ? AND fast_input_per_mtok = 0"
  );
  setFast.run(10, 50, "claude-opus-4-8%");
  setFast.run(30, 150, "claude-opus-4-7%");
  setFast.run(30, 150, "claude-opus-4-6%");
}

// Migrate: add time-limited introductory-rate columns to model_pricing.
// Usage on/before intro_until prices at the intro_* rates; usage after prices at
// standard - so promo pricing (e.g. Claude Sonnet 5's launch discount) stays
// correct for both historical and future usage. Additive + default 0/NULL, so
// existing rows keep behaving exactly as before until an intro rate is set.
try {
  db.prepare("SELECT intro_until FROM model_pricing LIMIT 1").get();
} catch {
  for (const col of [
    "intro_input_per_mtok",
    "intro_output_per_mtok",
    "intro_cache_read_per_mtok",
    "intro_cache_write_per_mtok",
    "intro_cache_write_1h_per_mtok",
  ]) {
    db.prepare(`ALTER TABLE model_pricing ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`).run();
  }
  db.prepare("ALTER TABLE model_pricing ADD COLUMN intro_until TEXT").run();
}

// Migrate: label each briefing with the persona variant that composed it (Phase
// N). Additive + nullable; existing rows read as null (= JARVIS, the only variant
// that existed before). The Briefings page shows it so an Ultron-voiced briefing
// is identifiable in history.
try {
  db.prepare("SELECT persona FROM briefings LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE briefings ADD COLUMN persona TEXT").run();
}

// Default model pricing - shared by initial seed + startup top-up + reset endpoint
// Columns: pattern, display_name, input, output, cache_read (hits & refreshes),
//          cache_write (5m ephemeral writes), cache_write_1h (1h ephemeral writes),
//          fast_input, fast_output (fast-mode premium; 0 = model has no fast pricing)
// Each model gets its own explicit row - no catch-all grouping.
// Rate shape mirrors Anthropic's published table: 5m write = 1.25× input, 1h write = 2× input.
const DEFAULT_PRICING = [
  // Next-gen flagship
  ["claude-fable-5%", "Claude Fable 5", 10, 50, 1, 12.5, 20, 0, 0],
  ["claude-mythos-5%", "Claude Mythos 5", 10, 50, 1, 12.5, 20, 0, 0],
  // Opus family (fast mode available on 4.6 / 4.7 / 4.8)
  ["claude-opus-4-8%", "Claude Opus 4.8", 5, 25, 0.5, 6.25, 10, 10, 50],
  ["claude-opus-4-7%", "Claude Opus 4.7", 5, 25, 0.5, 6.25, 10, 30, 150],
  ["claude-opus-4-6%", "Claude Opus 4.6", 5, 25, 0.5, 6.25, 10, 30, 150],
  ["claude-opus-4-5%", "Claude Opus 4.5", 5, 25, 0.5, 6.25, 10, 0, 0],
  ["claude-opus-4-1%", "Claude Opus 4.1", 15, 75, 1.5, 18.75, 30, 0, 0],
  ["claude-opus-4-2%", "Claude Opus 4", 15, 75, 1.5, 18.75, 30, 0, 0],
  // Sonnet family
  ["claude-sonnet-5%", "Claude Sonnet 5", 3, 15, 0.3, 3.75, 6, 0, 0],
  ["claude-sonnet-4-6%", "Claude Sonnet 4.6", 3, 15, 0.3, 3.75, 6, 0, 0],
  ["claude-sonnet-4-5%", "Claude Sonnet 4.5", 3, 15, 0.3, 3.75, 6, 0, 0],
  ["claude-sonnet-4-2%", "Claude Sonnet 4", 3, 15, 0.3, 3.75, 6, 0, 0],
  ["claude-3-7-sonnet%", "Claude Sonnet 3.7", 3, 15, 0.3, 3.75, 6, 0, 0],
  ["claude-3-5-sonnet%", "Claude Sonnet 3.5", 3, 15, 0.3, 3.75, 6, 0, 0],
  // Haiku family
  ["claude-haiku-4-5%", "Claude Haiku 4.5", 1, 5, 0.1, 1.25, 2, 0, 0],
  ["claude-3-5-haiku%", "Claude Haiku 3.5", 0.8, 4, 0.08, 1, 1.6, 0, 0],
  ["claude-3-haiku%", "Claude Haiku 3", 0.25, 1.25, 0.03, 0.3, 0.5, 0, 0],
  // Legacy
  ["claude-3-opus%", "Claude Opus 3", 15, 75, 1.5, 18.75, 30, 0, 0],
];

// Top-up: insert any default pattern that isn't already present. Preserves
// user edits to existing rows - we only add what's missing, never overwrite.
// This runs every startup so new default models (e.g. Opus 4.8) appear in the
// Settings UI automatically without requiring a manual "Reset Defaults".
{
  const existing = new Set(
    db
      .prepare("SELECT model_pattern FROM model_pricing")
      .all()
      .map((r) => r.model_pattern)
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO model_pricing (model_pattern, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok, fast_input_per_mtok, fast_output_per_mtok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const addMissing = db.transaction((rows) => {
    for (const [pattern, name, inp, out, cr, cw, cw1h, fin, fout] of rows) {
      if (!existing.has(pattern)) insert.run(pattern, name, inp, out, cr, cw, cw1h, fin, fout);
    }
  });
  addMissing(DEFAULT_PRICING);
}

// Known introductory promo rates: [pattern, in, out, cacheRead, cw5m, cw1h, until].
// Standard rates live in the DEFAULT_PRICING row; these add the time-limited
// discount on top. Claude Sonnet 5: 2/3-off launch pricing through 2026-08-31.
const DEFAULT_INTRO_PRICING = [["claude-sonnet-5%", 2, 10, 0.2, 2.5, 4, "2026-08-31"]];

// Backfill the known intro rates. Only fills rows whose intro_until is still
// NULL, so a user who edits or clears an intro rate in Settings is never
// overwritten. Shared by startup and the reset-pricing endpoint (which
// re-seeds standard rates and must re-apply the intro discount too, else Sonnet
// 5 would silently price at standard until the next restart).
function applyIntroPricing(dbHandle = db) {
  const setIntro = dbHandle.prepare(
    `UPDATE model_pricing SET
       intro_input_per_mtok = ?, intro_output_per_mtok = ?, intro_cache_read_per_mtok = ?,
       intro_cache_write_per_mtok = ?, intro_cache_write_1h_per_mtok = ?, intro_until = ?
     WHERE model_pattern = ? AND intro_until IS NULL`
  );
  for (const [pattern, inp, out, cr, cw5m, cw1h, until] of DEFAULT_INTRO_PRICING) {
    setIntro.run(inp, out, cr, cw5m, cw1h, until, pattern);
  }
}
applyIntroPricing();

// Migrate: if token_usage has rows without model column (old schema), add it
try {
  db.prepare("SELECT model FROM token_usage LIMIT 1").get();
} catch {
  // Old schema - recreate table with model column
  db.pragma("foreign_keys = OFF");
  db.prepare("ALTER TABLE token_usage RENAME TO token_usage_old").run();
  db.prepare(
    `
    CREATE TABLE token_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, model),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `
  ).run();
  db.prepare(
    `
    INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      SELECT tu.session_id, COALESCE(s.model, 'unknown'), tu.input_tokens, tu.output_tokens, tu.cache_read_tokens, tu.cache_write_tokens
      FROM token_usage_old tu LEFT JOIN sessions s ON s.id = tu.session_id
  `
  ).run();
  db.prepare("DROP TABLE token_usage_old").run();
  db.pragma("foreign_keys = ON");
}

// Migrate: chat attachments (Phase Q1) - additive JSON column on chat_messages
// ([{file, name, mimeType, size, kind}]; file lives under <dataDir>/chat-uploads).
try {
  db.prepare("SELECT attachments FROM chat_messages LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE chat_messages ADD COLUMN attachments TEXT").run();
}

// Migrate: add updated_at columns to sessions and agents
try {
  db.prepare("SELECT updated_at FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
  db.prepare("UPDATE sessions SET updated_at = COALESCE(ended_at, started_at)").run();
}
try {
  db.prepare("SELECT updated_at FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
  db.prepare("UPDATE agents SET updated_at = COALESCE(ended_at, started_at)").run();
}

// Composite index on (status, updated_at) - must be AFTER migration adds updated_at
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)`
);

// Migrate: add `awaiting_input_since` columns to sessions and agents.
// When Claude Code emits a Notification asking for permission or user input,
// we mark the session and its main agent as awaiting input by stamping this
// column with the notification's ISO timestamp. The underlying status enum
// stays unchanged (so existing CHECK constraints, queries, and aggregations
// keep working); the UI derives an effective "waiting" status whenever this
// column is non-null.
try {
  db.prepare("SELECT awaiting_input_since FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN awaiting_input_since TEXT").run();
}
try {
  db.prepare("SELECT awaiting_input_since FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN awaiting_input_since TEXT").run();
}

// Migrate: add `transcript_path` to sessions for fast active-session sweep.
// Before this, the periodic compaction sweep had to do
//   SELECT DISTINCT json_extract(events.data, '$.transcript_path') ...
// across the entire events table (250k+ rows in mature DBs). Storing the
// path on sessions lets the sweep query touch only active session rows.
// Backfilled once from the events table; thereafter populated by
// routes/hooks.js ensureSession() and the first event that carries
// transcript_path.
try {
  db.prepare("SELECT transcript_path FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN transcript_path TEXT").run();
  // Backfill: pull the first transcript_path we can find in events for each
  // session. Uses a correlated subquery so SQLite limits the inner scan to
  // each session's rows (still bounded by events row count, but only runs
  // once per DB lifetime).
  // json_valid guard: legacy events.data may hold non-JSON text. Without it,
  // json_extract throws "malformed JSON" mid-UPDATE and aborts startup.
  db.prepare(
    `UPDATE sessions SET transcript_path = (
       SELECT json_extract(e.data, '$.transcript_path')
       FROM events e
       WHERE e.session_id = sessions.id
         AND json_valid(e.data) = 1
         AND json_extract(e.data, '$.transcript_path') IS NOT NULL
       LIMIT 1
     ) WHERE transcript_path IS NULL`
  ).run();
}

// Partial index for the periodic active-session sweep - covers only the
// handful of rows the sweep actually reads.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sessions_active_tp
   ON sessions(status, transcript_path)
   WHERE status='active' AND transcript_path IS NOT NULL`
);

// Migrate: add `provider` to sessions (Phase AB1). Additive, default 'claude',
// so existing rows/queries are untouched; Codex rollout ingestion
// (lib/codex-watcher.js) tags its rows 'codex'.
try {
  db.prepare("SELECT provider FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'").run();
}

// Migrate legacy scheduled_prompts rows into the richer mission scheduler
// without rewriting or invalidating the existing one-shot run records.
for (const [name, definition] of [
  ["recurrence", "TEXT"],
  ["domain", "TEXT NOT NULL DEFAULT 'personal'"],
  ["owner_provider", "TEXT"],
  ["model_tier", "TEXT"],
  ["workspace", "TEXT"],
  ["agent_role", "TEXT"],
  ["approval_policy", "TEXT NOT NULL DEFAULT 'never'"],
  ["sandbox_policy", "TEXT NOT NULL DEFAULT 'read-only'"],
  ["thread_strategy", "TEXT NOT NULL DEFAULT 'new_thread'"],
  ["notification_policy", "TEXT NOT NULL DEFAULT 'all'"],
  ["overlap_policy", "TEXT NOT NULL DEFAULT 'skip'"],
  ["missed_run_policy", "TEXT NOT NULL DEFAULT 'run_once'"],
  ["retry_limit", "INTEGER NOT NULL DEFAULT 0"],
  ["retry_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["timeout_seconds", "INTEGER NOT NULL DEFAULT 1800"],
  ["current_mission_id", "TEXT"],
  ["last_mission_id", "TEXT"],
  ["native_thread_id", "TEXT"],
]) {
  try {
    db.prepare(`SELECT ${name} FROM scheduled_prompts LIMIT 1`).get();
  } catch {
    db.prepare(`ALTER TABLE scheduled_prompts ADD COLUMN ${name} ${definition}`).run();
  }
}

// Migrate webhook_targets for first-class providers. Earlier installs created
// the table with a 4-value `type` CHECK (slack/discord/teams/generic) and no
// `config` column. SQLite can't drop a CHECK in place, so rebuild the table
// when the legacy constraint is present; otherwise just add the column.
{
  const meta = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='webhook_targets'")
    .get();
  const hasLegacyCheck =
    meta && meta.sql && meta.sql.includes("'slack','discord','teams','generic'");
  if (hasLegacyCheck) {
    db.exec(`
      ALTER TABLE webhook_targets RENAME TO webhook_targets_old;
      CREATE TABLE webhook_targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret TEXT,
        headers TEXT,
        rule_ids TEXT,
        config TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO webhook_targets (id, name, type, url, enabled, secret, headers, rule_ids, config, created_at, updated_at)
        SELECT id, name, type, url, enabled, secret, headers, rule_ids, NULL, created_at, updated_at FROM webhook_targets_old;
      DROP TABLE webhook_targets_old;
    `);
  } else {
    try {
      db.prepare("SELECT config FROM webhook_targets LIMIT 1").get();
    } catch {
      db.prepare("ALTER TABLE webhook_targets ADD COLUMN config TEXT").run();
    }
  }
}

// Migrate: replace legacy idle/connected agent statuses with waiting/working
// and update the CHECK constraint to the 4-status model.
// SQLite doesn't support ALTER CHECK, so we detect the old constraint and
// rebuild the table with rename-copy-drop when needed.
{
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'")
    .get();
  if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'idle'")) {
    // Old constraint found - rebuild the table
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      -- Map old statuses to new ones in-place (still valid under old constraint isn't needed
      -- because we're about to drop the table - we do it in the INSERT below)
      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'main' CHECK(type IN ('main','subagent')),
        subagent_type TEXT,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('working','waiting','completed','error')),
        task TEXT,
        current_tool TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ended_at TEXT,
        parent_agent_id TEXT,
        metadata TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        awaiting_input_since TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
      INSERT INTO agents_new SELECT
        id, session_id, name, type, subagent_type,
        CASE status
          WHEN 'idle' THEN 'waiting'
          WHEN 'connected' THEN 'working'
          ELSE status
        END,
        task, current_tool, started_at, ended_at, parent_agent_id, metadata,
        updated_at, awaiting_input_since
      FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    // Recreate indexes that were on the old table
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    `);
  }
}

// Migrate: add compaction baseline columns to token_usage.
// When conversation compaction rewrites the JSONL, pre-compaction token counts
// are lost from the transcript. Baselines preserve those counts so the effective
// total = current + baseline.
try {
  db.prepare("SELECT baseline_input FROM token_usage LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE token_usage ADD COLUMN baseline_input INTEGER NOT NULL DEFAULT 0").run();
  db.prepare("ALTER TABLE token_usage ADD COLUMN baseline_output INTEGER NOT NULL DEFAULT 0").run();
  db.prepare(
    "ALTER TABLE token_usage ADD COLUMN baseline_cache_read INTEGER NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    "ALTER TABLE token_usage ADD COLUMN baseline_cache_write INTEGER NOT NULL DEFAULT 0"
  ).run();
}

// Migrate: re-key token_usage by pricing dimensions (speed / inference_geo /
// service_tier) and add the 1h cache-write split + server-tool request columns
// (with their compaction baselines). SQLite cannot alter a PRIMARY KEY in place,
// so recreate the table. Existing rows map to the standard / global / standard
// bucket with zero tool requests and zero 1h-writes - so their computed cost is
// IDENTICAL to before (all writes priced at the 5m rate). Fully backward
// compatible with historical sessions; old transcripts lacking these usage
// fields continue to price exactly as they did.
try {
  db.prepare("SELECT speed FROM token_usage LIMIT 1").get();
} catch {
  db.pragma("foreign_keys = OFF");
  db.prepare("ALTER TABLE token_usage RENAME TO token_usage_pre_modifiers").run();
  db.prepare(
    `
    CREATE TABLE token_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      speed TEXT NOT NULL DEFAULT 'standard',
      inference_geo TEXT NOT NULL DEFAULT 'global',
      service_tier TEXT NOT NULL DEFAULT 'standard',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_requests INTEGER NOT NULL DEFAULT 0,
      web_fetch_requests INTEGER NOT NULL DEFAULT 0,
      code_execution_requests INTEGER NOT NULL DEFAULT 0,
      baseline_input INTEGER NOT NULL DEFAULT 0,
      baseline_output INTEGER NOT NULL DEFAULT 0,
      baseline_cache_read INTEGER NOT NULL DEFAULT 0,
      baseline_cache_write INTEGER NOT NULL DEFAULT 0,
      baseline_cache_write_1h INTEGER NOT NULL DEFAULT 0,
      baseline_web_search INTEGER NOT NULL DEFAULT 0,
      baseline_web_fetch INTEGER NOT NULL DEFAULT 0,
      baseline_code_execution INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, model, speed, inference_geo, service_tier),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `
  ).run();
  db.prepare(
    `
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      baseline_input, baseline_output, baseline_cache_read, baseline_cache_write)
    SELECT session_id, model, 'standard', 'global', 'standard',
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      baseline_input, baseline_output, baseline_cache_read, baseline_cache_write
    FROM token_usage_pre_modifiers
  `
  ).run();
  db.prepare("DROP TABLE token_usage_pre_modifiers").run();
  db.pragma("foreign_keys = ON");
}

// Startup cleanup: mark stale active sessions as completed.
// Legacy sessions (created before SessionEnd hook) will never receive a SessionEnd event,
// so they stay "active" forever. Complete any active session whose last event is older than
// 1 hour - the CLI process is certainly gone by then.
db.prepare(
  `
  UPDATE sessions SET
    status = 'completed',
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE status = 'active'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    AND NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.session_id = sessions.id
        AND e.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    )
`
).run();

// Startup cleanup: complete orphaned agents on finished sessions
db.prepare(
  `
  UPDATE agents SET
    status = 'completed',
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE status IN ('working', 'waiting')
    AND session_id IN (SELECT id FROM sessions WHERE status IN ('completed', 'error', 'abandoned'))
`
).run();

// Startup repair: normalize compaction agents whose started_at > ended_at.
// Earlier hook ingestion (pre-#156) stamped started_at = NOW (ingestion wall
// clock) and ended_at = transcript timestamp (in the past), producing
// impossible negative durations that corrupted workflow analytics. Compaction
// is instantaneous from the user's perspective, so the transcript timestamp
// (preserved in ended_at) is the canonical value - collapse started_at to it.
// Idempotent: only touches rows where the invariant is broken.
db.prepare(
  `
  UPDATE agents SET
    started_at = ended_at,
    updated_at = ended_at
  WHERE subagent_type = 'compaction'
    AND ended_at IS NOT NULL
    AND julianday(ended_at) < julianday(started_at)
`
).run();

const stmts = {
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  listSessions: db.prepare(
    `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
     FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
     GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
  ),
  listSessionsByStatus: db.prepare(
    `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
     FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
     WHERE s.status = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
  ),
  insertSession: db.prepare(
    "INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)"
  ),
  updateSession: db.prepare(
    "UPDATE sessions SET name = COALESCE(?, name), status = COALESCE(?, status), ended_at = COALESCE(?, ended_at), metadata = COALESCE(?, metadata), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  reactivateSession: db.prepare(
    "UPDATE sessions SET status = 'active', ended_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  // Updates session.model only when the new value differs from what's stored,
  // so the broadcast/refresh path stays quiet across the common no-op case.
  // Used by the hook ingestor to keep the displayed model in sync after the
  // user invokes /model mid-session.
  updateSessionModel: db.prepare(
    "UPDATE sessions SET model = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND COALESCE(model, '') != ?"
  ),
  // Updates session.name only when the new value differs from what's stored.
  // Used by the hook ingestor / watchdog to keep the displayed session name in
  // sync with the transcript's title (set via /rename, `claude -n`, or the
  // auto-generated ai-title). No-op (zero changes) on the common unchanged
  // case so the broadcast path stays quiet.
  updateSessionName: db.prepare(
    "UPDATE sessions SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND COALESCE(name, '') != ?"
  ),
  // One-shot writer for sessions.transcript_path. The NULL/'' guard makes
  // every subsequent hook event for the same session a SQL no-op, so the
  // periodic compaction sweep can read transcript_path off the row instead
  // of scanning events.
  setSessionTranscriptPath: db.prepare(
    "UPDATE sessions SET transcript_path = ? WHERE id = ? AND (transcript_path IS NULL OR transcript_path = '')"
  ),

  getAgent: db.prepare("SELECT * FROM agents WHERE id = ?"),
  listAgents: db.prepare("SELECT * FROM agents ORDER BY started_at DESC LIMIT ? OFFSET ?"),
  listAgentsBySession: db.prepare(
    "SELECT * FROM agents WHERE session_id = ? ORDER BY started_at DESC"
  ),
  listAgentsByStatus: db.prepare(
    "SELECT * FROM agents WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?"
  ),
  insertAgent: db.prepare(
    "INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, parent_agent_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)"
  ),
  updateAgent: db.prepare(
    "UPDATE agents SET name = COALESCE(?, name), status = COALESCE(?, status), task = COALESCE(?, task), current_tool = ?, ended_at = COALESCE(?, ended_at), metadata = COALESCE(?, metadata), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  reactivateAgent: db.prepare(
    "UPDATE agents SET status = 'working', ended_at = NULL, current_tool = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  // Repoint a subagent at its true spawner. Used by reconcileSubagentParents to
  // fix nested subagents that were inserted flat under the main agent (hook and
  // JSONL ingestion can't know the spawner from a single file). Authoritative
  // parent comes from the spawner transcript's Task tool_result (agentId).
  setAgentParent: db.prepare(
    "UPDATE agents SET parent_agent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  // Awaiting-input state. Stamping awaiting_input_since marks the row as
  // "waiting" for user attention without touching the underlying status
  // enum (kept stable for legacy CHECK constraints and aggregations).
  setSessionAwaitingInput: db.prepare(
    "UPDATE sessions SET awaiting_input_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  clearSessionAwaitingInput: db.prepare(
    "UPDATE sessions SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND awaiting_input_since IS NOT NULL"
  ),
  setAgentAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  clearAgentAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND awaiting_input_since IS NOT NULL"
  ),
  clearSessionAgentsAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND awaiting_input_since IS NOT NULL"
  ),
  // Find the deepest currently-working subagent in a session using a recursive CTE.
  // Used to infer which agent is spawning a new subagent when hook events don't
  // carry an explicit agent ID. Returns the most recently created deepest agent.
  findDeepestWorkingAgent: db.prepare(`
    WITH RECURSIVE agent_depth AS (
      SELECT id, parent_agent_id, 0 as depth
      FROM agents
      WHERE session_id = ? AND parent_agent_id IS NULL
      UNION ALL
      SELECT a.id, a.parent_agent_id, ad.depth + 1
      FROM agents a
      JOIN agent_depth ad ON a.parent_agent_id = ad.id
      WHERE a.session_id = ?
    )
    SELECT ad.id, ad.depth
    FROM agent_depth ad
    JOIN agents a ON a.id = ad.id
    WHERE a.status = 'working' AND a.type = 'subagent'
    ORDER BY ad.depth DESC, a.started_at DESC
    LIMIT 1
  `),

  touchSession: db.prepare(
    "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  findStaleSessions: db.prepare(
    `SELECT id FROM sessions
     WHERE status = 'active' AND id != ?
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' minutes')`
  ),

  insertEvent: db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ),
  listEvents: db.prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"),
  listEventsBySession: db.prepare(
    "SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC, id DESC"
  ),
  countEvents: db.prepare("SELECT COUNT(*) as count FROM events"),
  countEventsSince: db.prepare("SELECT COUNT(*) as count FROM events WHERE created_at >= ?"),
  // Accepts tz modifier (e.g. '-420 minutes') to compute local midnight in UTC.
  // Pattern: shift now→local, truncate to day start, shift back→UTC.
  countEventsToday: db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE created_at >= datetime('now', ?, 'start of day', ?)"
  ),
  // Event timestamps at/after an ISO bound, oldest first. Used to derive the
  // rolling 5-hour session-usage window (see routes/stats.js). The caller
  // passes an ISO-8601 UTC string so the comparison stays chronological
  // (created_at is stored in the same ISO 'Z' format - a datetime() modifier
  // would produce a space-separated form that breaks sub-day comparisons).
  recentEventTimes: db.prepare(
    "SELECT created_at FROM events WHERE created_at >= ? ORDER BY created_at ASC"
  ),

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'active') as active_sessions,
      (SELECT COUNT(*) FROM agents WHERE status IN ('working', 'waiting')) as active_agents,
      (SELECT COUNT(*) FROM agents) as total_agents,
      (SELECT COUNT(*) FROM events) as total_events
  `),
  agentStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status"),
  sessionStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM sessions GROUP BY status"),

  // Legacy additive upsert. Targets the standard/global/standard bucket; kept
  // for backward compatibility with any caller using the original 6-arg shape.
  upsertTokenUsage: db.prepare(`
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, ?, 'standard', 'global', 'standard', ?, ?, ?, ?)
    ON CONFLICT(session_id, model, speed, inference_geo, service_tier) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens
  `),
  // Replace a bucket's totals with the latest full re-parse, keeping the
  // effective total (`live + baseline`) a monotonic HIGH-WATER MARK: it never
  // decreases, but it also never inflates past the largest value ever seen.
  //
  //   baseline := max(old_live + old_baseline - new_live, 0)
  //   live     := new_live
  //   ⇒ effective = new_live + baseline = max(old_effective, new_live)
  //
  // Why not the old `baseline += old_live` on any decrease: two writers hit the
  // same (session, model, …) bucket with DIFFERENT scopes - the live hook writer
  // stores main-transcript-only tokens (server/routes/hooks.js), while
  // importSession stores main+subagents combined (combineSessionTokens). Every
  // time the smaller write followed the larger, the old formula mistook it for a
  // compaction and ADDED the current value into baseline, so a long-lived,
  // frequently-reswept session accumulated a baseline many times its real usage
  // (a 26-day/80-repo session reached ~11× - its transcript proved 774M
  // cache-read while baseline claimed 8.5B). Transcripts are append-only, so a
  // full re-parse always sees the complete total; the high-water mark preserves
  // the true max across writer-scope noise and re-imports without ever
  // double-counting. Args, in order:
  //   session_id, model, speed, inference_geo, service_tier,
  //   input, output, cache_read, cache_write, cache_write_1h,
  //   web_search, web_fetch, code_execution
  replaceTokenUsage: db.prepare(`
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
                             web_search_requests, web_fetch_requests, code_execution_requests,
                             baseline_input, baseline_output, baseline_cache_read, baseline_cache_write, baseline_cache_write_1h,
                             baseline_web_search, baseline_web_fetch, baseline_code_execution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)
    ON CONFLICT(session_id, model, speed, inference_geo, service_tier) DO UPDATE SET
      baseline_input = MAX(input_tokens + baseline_input - excluded.input_tokens, 0),
      baseline_output = MAX(output_tokens + baseline_output - excluded.output_tokens, 0),
      baseline_cache_read = MAX(cache_read_tokens + baseline_cache_read - excluded.cache_read_tokens, 0),
      baseline_cache_write = MAX(cache_write_tokens + baseline_cache_write - excluded.cache_write_tokens, 0),
      baseline_cache_write_1h = MAX(cache_write_1h_tokens + baseline_cache_write_1h - excluded.cache_write_1h_tokens, 0),
      baseline_web_search = MAX(web_search_requests + baseline_web_search - excluded.web_search_requests, 0),
      baseline_web_fetch = MAX(web_fetch_requests + baseline_web_fetch - excluded.web_fetch_requests, 0),
      baseline_code_execution = MAX(code_execution_requests + baseline_code_execution - excluded.code_execution_requests, 0),
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cache_write_1h_tokens = excluded.cache_write_1h_tokens,
      web_search_requests = excluded.web_search_requests,
      web_fetch_requests = excluded.web_fetch_requests,
      code_execution_requests = excluded.code_execution_requests
  `),
  getTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + baseline_input), 0) as total_input,
      COALESCE(SUM(output_tokens + baseline_output), 0) as total_output,
      COALESCE(SUM(cache_read_tokens + baseline_cache_read), 0) as total_cache_read,
      COALESCE(SUM(cache_write_tokens + baseline_cache_write), 0) as total_cache_write,
      COALESCE(SUM(cache_write_1h_tokens + baseline_cache_write_1h), 0) as total_cache_write_1h,
      COALESCE(SUM(web_search_requests + baseline_web_search), 0) as total_web_search,
      COALESCE(SUM(web_fetch_requests + baseline_web_fetch), 0) as total_web_fetch,
      COALESCE(SUM(code_execution_requests + baseline_code_execution), 0) as total_code_execution
    FROM token_usage
  `),
  getTokensBySession: db.prepare(
    `SELECT model, speed, inference_geo, service_tier,
      input_tokens + baseline_input as input_tokens,
      output_tokens + baseline_output as output_tokens,
      cache_read_tokens + baseline_cache_read as cache_read_tokens,
      cache_write_tokens + baseline_cache_write as cache_write_tokens,
      cache_write_1h_tokens + baseline_cache_write_1h as cache_write_1h_tokens,
      web_search_requests + baseline_web_search as web_search_requests,
      web_fetch_requests + baseline_web_fetch as web_fetch_requests,
      code_execution_requests + baseline_code_execution as code_execution_requests
    FROM token_usage WHERE session_id = ?`
  ),

  // Model pricing
  listPricing: db.prepare("SELECT * FROM model_pricing ORDER BY display_name ASC"),
  getPricing: db.prepare("SELECT * FROM model_pricing WHERE model_pattern = ?"),
  upsertPricing: db.prepare(`
    INSERT INTO model_pricing (model_pattern, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok, fast_input_per_mtok, fast_output_per_mtok, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(model_pattern) DO UPDATE SET
      display_name = excluded.display_name,
      input_per_mtok = excluded.input_per_mtok,
      output_per_mtok = excluded.output_per_mtok,
      cache_read_per_mtok = excluded.cache_read_per_mtok,
      cache_write_per_mtok = excluded.cache_write_per_mtok,
      cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
      fast_input_per_mtok = excluded.fast_input_per_mtok,
      fast_output_per_mtok = excluded.fast_output_per_mtok,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
  // Update ONLY the time-limited introductory rates for an existing row. Kept
  // separate from upsertPricing so a standard-rate edit never touches intro
  // columns (and vice versa): the PUT route calls this only when the caller
  // actually sends intro fields, so legacy callers that omit them preserve any
  // promo untouched. intro_until = NULL clears the promo (row reverts to
  // standard rates at all dates). This is fully generic - any model pattern can
  // carry a promo window, not just Sonnet 5.
  setIntroPricing: db.prepare(`
    UPDATE model_pricing SET
      intro_input_per_mtok = ?,
      intro_output_per_mtok = ?,
      intro_cache_read_per_mtok = ?,
      intro_cache_write_per_mtok = ?,
      intro_cache_write_1h_per_mtok = ?,
      intro_until = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE model_pattern = ?
  `),
  deletePricing: db.prepare("DELETE FROM model_pricing WHERE model_pattern = ?"),
  matchPricing: db.prepare(
    "SELECT * FROM model_pricing WHERE ? LIKE REPLACE(model_pattern, '%', '%') LIMIT 1"
  ),
  toolUsageCounts: db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 20
  `),
  // Accept a timezone modifier (e.g. '-420 minutes') so GROUP BY uses local dates
  dailyEventCounts: db.prepare(`
    SELECT DATE(created_at, ?) as date, COUNT(*) as count
    FROM events
    WHERE created_at >= DATE('now', '-365 days')
    GROUP BY 1
    ORDER BY date ASC
  `),
  dailySessionCounts: db.prepare(`
    SELECT DATE(started_at, ?) as date, COUNT(*) as count
    FROM sessions
    WHERE started_at >= DATE('now', '-365 days')
    GROUP BY 1
    ORDER BY date ASC
  `),
  agentTypeDistribution: db.prepare(`
    SELECT subagent_type, COUNT(*) as count
    FROM agents
    WHERE type = 'subagent' AND subagent_type IS NOT NULL
    GROUP BY subagent_type
    ORDER BY count DESC
  `),
  totalSubagentCount: db.prepare("SELECT COUNT(*) as count FROM agents WHERE type = 'subagent'"),
  eventTypeCounts: db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events
    GROUP BY event_type
    ORDER BY count DESC
  `),
  avgEventsPerSession: db.prepare(`
    SELECT ROUND(CAST(COUNT(*) AS REAL) / MAX(1, (SELECT COUNT(*) FROM sessions)), 1) as avg
    FROM events
  `),

  // Per-session aggregations powering the SessionOverview panel.
  sessionEventCount: db.prepare("SELECT COUNT(*) as count FROM events WHERE session_id = ?"),
  sessionEventTypeCounts: db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events
    WHERE session_id = ?
    GROUP BY event_type
    ORDER BY count DESC
  `),
  sessionToolUsageCounts: db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 15
  `),
  // Errors are surfaced via a couple of conventions: event_type containing
  // "error" (case-insensitive) OR a summary prefixed with "Error" / "Failed".
  // We accept both so legacy and current hook conventions both count.
  sessionErrorCount: db.prepare(`
    SELECT COUNT(*) as count
    FROM events
    WHERE session_id = ?
      AND (
        LOWER(event_type) LIKE '%error%'
        OR LOWER(event_type) LIKE '%failed%'
        OR LOWER(summary) LIKE 'error%'
        OR LOWER(summary) LIKE 'failed%'
      )
  `),
  sessionEventTimeRange: db.prepare(`
    SELECT MIN(created_at) as first_at, MAX(created_at) as last_at
    FROM events
    WHERE session_id = ?
  `),
  sessionAgentTypeCounts: db.prepare(`
    SELECT
      COALESCE(subagent_type, 'unknown') as subagent_type,
      COUNT(*) as count
    FROM agents
    WHERE session_id = ? AND type = 'subagent'
    GROUP BY COALESCE(subagent_type, 'unknown')
    ORDER BY count DESC
  `),
  sessionAgentStatusCounts: db.prepare(`
    SELECT status, COUNT(*) as count
    FROM agents
    WHERE session_id = ?
    GROUP BY status
  `),
  sessionTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens
    FROM token_usage
    WHERE session_id = ?
  `),

  // ── Alerting engine ───────────────────────────────────────────────────────
  listAlertRules: db.prepare("SELECT * FROM alert_rules ORDER BY created_at DESC"),
  listEnabledAlertRules: db.prepare("SELECT * FROM alert_rules WHERE enabled = 1"),
  getAlertRule: db.prepare("SELECT * FROM alert_rules WHERE id = ?"),
  insertAlertRule: db.prepare(
    "INSERT INTO alert_rules (id, name, rule_type, config, enabled, cooldown_seconds) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  updateAlertRule: db.prepare(
    "UPDATE alert_rules SET name = COALESCE(?, name), config = COALESCE(?, config), enabled = COALESCE(?, enabled), cooldown_seconds = COALESCE(?, cooldown_seconds), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  deleteAlertRule: db.prepare("DELETE FROM alert_rules WHERE id = ?"),

  insertAlertEvent: db.prepare(
    "INSERT INTO alert_events (rule_id, rule_name, rule_type, session_id, agent_id, message, details) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  getAlertEvent: db.prepare("SELECT * FROM alert_events WHERE id = ?"),
  listAlertEvents: db.prepare(
    "SELECT * FROM alert_events ORDER BY triggered_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  listUnackedAlertEvents: db.prepare(
    "SELECT * FROM alert_events WHERE acknowledged_at IS NULL ORDER BY triggered_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  countAlertEvents: db.prepare("SELECT COUNT(*) as count FROM alert_events"),
  countUnackedAlertEvents: db.prepare(
    "SELECT COUNT(*) as count FROM alert_events WHERE acknowledged_at IS NULL"
  ),
  ackAlertEvent: db.prepare(
    "UPDATE alert_events SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND acknowledged_at IS NULL"
  ),
  ackAllAlertEvents: db.prepare(
    "UPDATE alert_events SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE acknowledged_at IS NULL"
  ),
  // Cooldown lookup: most recent firing of a rule for a given scope (session,
  // or session+agent for per-agent rules). COALESCE folds NULL scopes to ''.
  lastAlertFor: db.prepare(
    `SELECT triggered_at FROM alert_events
     WHERE rule_id = ? AND COALESCE(session_id, '') = COALESCE(?, '') AND COALESCE(agent_id, '') = COALESCE(?, '')
     ORDER BY triggered_at DESC, id DESC LIMIT 1`
  ),

  // ── Webhook delivery ──────────────────────────────────────────────────────
  listWebhookTargets: db.prepare("SELECT * FROM webhook_targets ORDER BY created_at DESC"),
  listEnabledWebhookTargets: db.prepare("SELECT * FROM webhook_targets WHERE enabled = 1"),
  getWebhookTarget: db.prepare("SELECT * FROM webhook_targets WHERE id = ?"),
  insertWebhookTarget: db.prepare(
    "INSERT INTO webhook_targets (id, name, type, url, enabled, secret, headers, rule_ids, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  // Partial update: COALESCE keeps the existing value when a column arg is
  // NULL. url/secret/headers/rule_ids/config are nullable *values*, so they use
  // a companion "_set" flag arg to distinguish "leave alone" from "clear".
  updateWebhookTarget: db.prepare(
    `UPDATE webhook_targets SET
       name = COALESCE(?, name),
       url = COALESCE(?, url),
       enabled = COALESCE(?, enabled),
       secret = CASE WHEN ? = 1 THEN ? ELSE secret END,
       headers = CASE WHEN ? = 1 THEN ? ELSE headers END,
       rule_ids = CASE WHEN ? = 1 THEN ? ELSE rule_ids END,
       config = CASE WHEN ? = 1 THEN ? ELSE config END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`
  ),
  deleteWebhookTarget: db.prepare("DELETE FROM webhook_targets WHERE id = ?"),

  insertWebhookDelivery: db.prepare(
    "INSERT INTO webhook_deliveries (target_id, target_name, target_type, alert_id, status, status_code, attempts, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  listWebhookDeliveriesForTarget: db.prepare(
    "SELECT * FROM webhook_deliveries WHERE target_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  lastWebhookDeliveryForTarget: db.prepare(
    "SELECT * FROM webhook_deliveries WHERE target_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ),
  // Keep the delivery log bounded - prune everything older than the newest
  // 2000 rows after each insert (cheap with the created_at index).
  pruneWebhookDeliveries: db.prepare(
    `DELETE FROM webhook_deliveries WHERE id NOT IN (
       SELECT id FROM webhook_deliveries ORDER BY created_at DESC, id DESC LIMIT 2000
     )`
  ),

  // ── Workflow-tool runs ────────────────────────────────────────────────────
  // Upsert keyed by run_id. started_at and created_at are written only on first
  // insert (COALESCE keeps the existing launch time across a running→completed
  // transition); every other field reflects the latest journal/scan.
  upsertWorkflow: db.prepare(
    `INSERT INTO workflows
       (run_id, session_id, task_id, name, status, default_model, started_at, ended_at,
        duration_ms, agent_count, total_tokens, total_tool_calls, phases, progress,
        script_path, journal_path, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(run_id) DO UPDATE SET
       session_id = excluded.session_id,
       task_id = COALESCE(excluded.task_id, workflows.task_id),
       name = COALESCE(excluded.name, workflows.name),
       status = excluded.status,
       default_model = COALESCE(excluded.default_model, workflows.default_model),
       started_at = COALESCE(workflows.started_at, excluded.started_at),
       ended_at = excluded.ended_at,
       duration_ms = excluded.duration_ms,
       agent_count = excluded.agent_count,
       total_tokens = excluded.total_tokens,
       total_tool_calls = excluded.total_tool_calls,
       phases = COALESCE(excluded.phases, workflows.phases),
       progress = COALESCE(excluded.progress, workflows.progress),
       script_path = COALESCE(excluded.script_path, workflows.script_path),
       journal_path = COALESCE(excluded.journal_path, workflows.journal_path),
       source = excluded.source,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ),
  getWorkflow: db.prepare("SELECT * FROM workflows WHERE run_id = ?"),
  listWorkflowsBySession: db.prepare(
    "SELECT * FROM workflows WHERE session_id = ? ORDER BY started_at DESC, created_at DESC"
  ),
  listWorkflows: db.prepare(
    "SELECT * FROM workflows ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  listWorkflowsByStatus: db.prepare(
    "SELECT * FROM workflows WHERE status = ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  listWorkflowsBySessionFilter: db.prepare(
    "SELECT * FROM workflows WHERE session_id = ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  countWorkflows: db.prepare("SELECT COUNT(*) AS n FROM workflows"),
  countWorkflowsByStatus: db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE status = ?"),
  workflowStatusCounts: db.prepare("SELECT status, COUNT(*) AS n FROM workflows GROUP BY status"),
  setAgentWorkflow: db.prepare(
    "UPDATE agents SET workflow_run_id = ?, workflow_phase = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  listAgentsByWorkflow: db.prepare(
    "SELECT * FROM agents WHERE workflow_run_id = ? ORDER BY started_at ASC, id ASC"
  ),

  // ── Multi-account tracking (Phase K) ──────────────────────────────────────
  listAccounts: db.prepare("SELECT * FROM accounts ORDER BY active DESC, last_active DESC"),
  getAccount: db.prepare("SELECT * FROM accounts WHERE id = ?"),
  getActiveAccount: db.prepare("SELECT * FROM accounts WHERE active = 1 LIMIT 1"),
  // Upsert an observed account. Preserves first_seen; refreshes label/reset info.
  upsertAccount: db.prepare(`
    INSERT INTO accounts (id, label, active, last_active, resets_at, metadata)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = COALESCE(excluded.label, accounts.label),
      resets_at = COALESCE(excluded.resets_at, accounts.resets_at),
      metadata = COALESCE(excluded.metadata, accounts.metadata)
  `),
  // Flip exactly one account active; clear the flag on all others. Two-step,
  // run inside a transaction by the caller (see claude-swap.js).
  clearActiveAccounts: db.prepare("UPDATE accounts SET active = 0 WHERE active = 1"),
  setActiveAccount: db.prepare(
    "UPDATE accounts SET active = 1, last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  setAccountResetsAt: db.prepare("UPDATE accounts SET resets_at = ? WHERE id = ?"),
  insertAccountSwap: db.prepare(
    "INSERT INTO account_swaps (from_account, to_account, reason) VALUES (?, ?, ?)"
  ),
  listAccountSwaps: db.prepare(
    "SELECT * FROM account_swaps ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),

  // ── Scheduled & chained prompts (Phase L) ─────────────────────────────────
  insertSchedule: db.prepare(`
    INSERT INTO scheduled_prompts (
      id, label, prompt, target_kind, target_opts, trigger_kind, fire_at,
      trigger_run_id, status_filter, status, chain_depth
    ) VALUES (
      @id, @label, @prompt, @target_kind, @target_opts, @trigger_kind, @fire_at,
      @trigger_run_id, @status_filter, 'pending', @chain_depth
    )
  `),
  getSchedule: db.prepare("SELECT * FROM scheduled_prompts WHERE id = ?"),
  listSchedules: db.prepare(
    "SELECT * FROM scheduled_prompts ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  listSchedulesByStatus: db.prepare(
    "SELECT * FROM scheduled_prompts WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  listPendingSchedules: db.prepare(
    "SELECT * FROM scheduled_prompts WHERE status = 'pending' ORDER BY created_at ASC, id ASC"
  ),
  // Pending schedules watching a particular run's completion (for the run-status hook).
  listPendingSchedulesForRun: db.prepare(
    "SELECT * FROM scheduled_prompts WHERE status = 'pending' AND trigger_kind = 'on_run_complete' AND trigger_run_id = ?"
  ),
  // Pending schedules that depend (via on_run_complete) on a given schedule's
  // result run - used by cancel-cascade to find dependents.
  updateScheduleFired: db.prepare(
    "UPDATE scheduled_prompts SET status = 'fired', fired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), result_run_id = ?, late = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
  ),
  updateScheduleFailed: db.prepare(
    "UPDATE scheduled_prompts SET status = 'failed', fired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
  ),
  updateScheduleCancelled: db.prepare(
    "UPDATE scheduled_prompts SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
  ),
  updateScheduleFields: db.prepare(
    "UPDATE scheduled_prompts SET label = COALESCE(?, label), prompt = COALESCE(?, prompt), fire_at = COALESCE(?, fire_at), status_filter = COALESCE(?, status_filter), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
  ),

  // ── Multi-provider chat (Phase E) ────────────────────────────────────────
  insertChat: db.prepare(
    "INSERT INTO chats (id, title, provider, model, project_id) VALUES (@id, @title, @provider, @model, @project_id)"
  ),
  // Chats have no cwd, so unlike sessions/runs there is no auto-association -
  // project_id is only ever set explicitly (Phase F).
  setChatProject: db.prepare(
    "UPDATE chats SET project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  getChat: db.prepare("SELECT * FROM chats WHERE id = ?"),
  listChats: db.prepare("SELECT * FROM chats ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?"),
  deleteChat: db.prepare("DELETE FROM chats WHERE id = ?"),
  touchChat: db.prepare(
    "UPDATE chats SET provider = COALESCE(?, provider), model = COALESCE(?, model), cc_session_id = COALESCE(?, cc_session_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  renameChat: db.prepare(
    "UPDATE chats SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  insertChatMessage: db.prepare(
    "INSERT INTO chat_messages (id, chat_id, role, provider, model, content, image_path, attachments) VALUES (@id, @chat_id, @role, @provider, @model, @content, @image_path, @attachments)"
  ),
  listChatMessages: db.prepare(
    "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC"
  ),

  // ── Projects (Phase F) ────────────────────────────────────────────────────
  insertProject: db.prepare(`
    INSERT INTO projects (id, name, description, status, repo_path, notes_dir)
    VALUES (@id, @name, @description, @status, @repo_path, @notes_dir)
  `),
  getProject: db.prepare("SELECT * FROM projects WHERE id = ?"),
  listProjects: db.prepare("SELECT * FROM projects ORDER BY updated_at DESC"),
  listProjectsByStatus: db.prepare(
    "SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC"
  ),
  updateProject: db.prepare(`
    UPDATE projects SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      status = COALESCE(?, status),
      repo_path = COALESCE(?, repo_path),
      notes_dir = COALESCE(?, notes_dir),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `),
  deleteProject: db.prepare("DELETE FROM projects WHERE id = ?"),
  // Un-tag (not delete) activity rows before a project is removed - the
  // project is an organizing label, not the system of record for the
  // sessions/runs/chats it grouped, so deleting it must never touch them.
  clearProjectFromSessions: db.prepare(
    "UPDATE sessions SET project_id = NULL WHERE project_id = ?"
  ),
  clearProjectFromRuns: db.prepare(
    "UPDATE dashboard_runs SET project_id = NULL WHERE project_id = ?"
  ),
  clearProjectFromChats: db.prepare("UPDATE chats SET project_id = NULL WHERE project_id = ?"),

  insertProjectPath: db.prepare(
    "INSERT INTO project_paths (id, project_id, repo_path) VALUES (?, ?, ?)"
  ),
  listProjectPathsByProject: db.prepare(
    "SELECT * FROM project_paths WHERE project_id = ? ORDER BY created_at ASC"
  ),
  // Small table (one row per repo a project spans) - safe to load in full for
  // the in-JS longest-prefix cwd match in server/lib/projects.js.
  listAllProjectPaths: db.prepare("SELECT * FROM project_paths"),
  getProjectPath: db.prepare("SELECT * FROM project_paths WHERE id = ?"),
  deleteProjectPath: db.prepare("DELETE FROM project_paths WHERE id = ?"),

  setSessionProject: db.prepare(
    "UPDATE sessions SET project_id = ? WHERE id = ? AND project_id IS NULL"
  ),
  setRunProject: db.prepare(
    "UPDATE dashboard_runs SET project_id = ? WHERE id = ? AND project_id IS NULL"
  ),
  // Backfill candidates: existing rows with a cwd but no project assigned yet.
  // Used when a project_paths entry is added so pre-existing history retroactively
  // associates instead of only new activity going forward.
  unassociatedSessionsWithCwd: db.prepare(
    "SELECT id, cwd FROM sessions WHERE project_id IS NULL AND cwd IS NOT NULL AND cwd != ''"
  ),
  unassociatedRunsWithCwd: db.prepare(
    "SELECT id, cwd FROM dashboard_runs WHERE project_id IS NULL AND cwd IS NOT NULL AND cwd != ''"
  ),

  // Rollup counts + recent items for the Projects card grid / detail view.
  countSessionsByProject: db.prepare("SELECT COUNT(*) as count FROM sessions WHERE project_id = ?"),
  countRunsByProject: db.prepare(
    "SELECT COUNT(*) as count FROM dashboard_runs WHERE project_id = ?"
  ),
  countChatsByProject: db.prepare("SELECT COUNT(*) as count FROM chats WHERE project_id = ?"),
  recentSessionsByProject: db.prepare(
    "SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?"
  ),
  recentRunsByProject: db.prepare(
    "SELECT * FROM dashboard_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?"
  ),
  recentChatsByProject: db.prepare(
    "SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?"
  ),
  lastActivityByProject: db.prepare(`
    SELECT MAX(t) as last_activity FROM (
      SELECT MAX(updated_at) as t FROM sessions WHERE project_id = ?
      UNION ALL
      SELECT MAX(started_at) as t FROM dashboard_runs WHERE project_id = ?
      UNION ALL
      SELECT MAX(updated_at) as t FROM chats WHERE project_id = ?
    )
  `),

  // ── App settings KV (Phase G) ─────────────────────────────────────────────
  getSetting: db.prepare("SELECT value FROM app_settings WHERE key = ?"),
  setSetting: db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ),

  // ── Notes index (Phase G1) ────────────────────────────────────────────────
  insertNote: db.prepare(`
    INSERT INTO notes (id, path, title, tags, project_id, source, excerpt, sensitive, mtime, created_at, updated_at)
    VALUES (@id, @path, @title, @tags, @project_id, @source, @excerpt, @sensitive, @mtime, @created_at, @updated_at)
  `),
  getNote: db.prepare("SELECT * FROM notes WHERE id = ?"),
  getNoteByPath: db.prepare("SELECT * FROM notes WHERE path = ?"),
  listNotes: db.prepare("SELECT * FROM notes ORDER BY updated_at DESC, id DESC"),
  listNotesByProject: db.prepare(
    "SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC, id DESC"
  ),
  deleteNote: db.prepare("DELETE FROM notes WHERE id = ?"),
  deleteNoteByPath: db.prepare("DELETE FROM notes WHERE path = ?"),
  allNotePaths: db.prepare("SELECT id, path, mtime FROM notes"),
  countNotesByProject: db.prepare("SELECT COUNT(*) as count FROM notes WHERE project_id = ?"),
  recentNotesByProject: db.prepare(
    "SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?"
  ),

  // ── Vault edges (Phase S) ─────────────────────────────────────────────────
  insertVaultEdge: db.prepare(`
    INSERT INTO vault_edges (src_id, dst_key, dst_id, type)
    VALUES (@src_id, @dst_key, @dst_id, @type)
    ON CONFLICT(src_id, dst_key, type) DO UPDATE SET dst_id = excluded.dst_id
  `),
  deleteVaultEdgesFrom: db.prepare("DELETE FROM vault_edges WHERE src_id = ?"),
  resolveVaultEdges: db.prepare("UPDATE vault_edges SET dst_id = ? WHERE dst_key = ?"),
  unresolveVaultEdges: db.prepare("UPDATE vault_edges SET dst_id = NULL WHERE dst_id = ?"),
  listVaultEdges: db.prepare(
    "SELECT src_id, dst_id, type FROM vault_edges WHERE dst_id IS NOT NULL"
  ),
  vaultEdgesFrom: db.prepare("SELECT * FROM vault_edges WHERE src_id = ?"),
  vaultEdgesTo: db.prepare("SELECT * FROM vault_edges WHERE dst_id = ?"),

  // ── Vault entity engine (Phase T) ─────────────────────────────────────────
  insertVaultEntity: db.prepare(`
    INSERT INTO vault_entities (id, name, type, aliases, note_id)
    VALUES (@id, @name, @type, @aliases, @note_id)
  `),
  listVaultEntities: db.prepare("SELECT * FROM vault_entities"),
  getVaultEntity: db.prepare("SELECT * FROM vault_entities WHERE id = ?"),
  setVaultEntityNoteId: db.prepare("UPDATE vault_entities SET note_id = ? WHERE id = ?"),
  clearVaultEntityNote: db.prepare("UPDATE vault_entities SET note_id = NULL WHERE note_id = ?"),
  insertVaultMention: db.prepare(
    "INSERT OR IGNORE INTO vault_mentions (entity_id, note_id) VALUES (?, ?)"
  ),
  countVaultMentions: db.prepare(
    "SELECT COUNT(DISTINCT note_id) AS n FROM vault_mentions WHERE entity_id = ?"
  ),
  listVaultMentionNotes: db.prepare("SELECT note_id FROM vault_mentions WHERE entity_id = ?"),
  deleteVaultMentionsForNote: db.prepare("DELETE FROM vault_mentions WHERE note_id = ?"),
  deleteVaultMentionsForEntity: db.prepare("DELETE FROM vault_mentions WHERE entity_id = ?"),
  deleteVaultEntity: db.prepare("DELETE FROM vault_entities WHERE id = ?"),
  setVaultEntityAliases: db.prepare("UPDATE vault_entities SET aliases = ? WHERE id = ?"),
  copyVaultMentions: db.prepare(`
    INSERT OR IGNORE INTO vault_mentions (entity_id, note_id)
    SELECT ?, note_id FROM vault_mentions WHERE entity_id = ?
  `),
  listVaultEntitiesForNote: db.prepare(`
    SELECT e.* FROM vault_entities e
    JOIN vault_mentions m ON m.entity_id = e.id
    WHERE m.note_id = ? AND e.note_id IS NOT NULL
  `),
  upsertVaultEntityFacts: db.prepare(`
    INSERT INTO vault_entity_facts (entity_id, source_note_id, facts)
    VALUES (?, ?, ?)
    ON CONFLICT(entity_id, source_note_id) DO UPDATE SET
      facts = excluded.facts,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
  listVaultEntityFacts: db.prepare(`
    SELECT f.source_note_id, f.facts, n.title AS source_title
    FROM vault_entity_facts f
    JOIN notes n ON n.id = f.source_note_id
    WHERE f.entity_id = ?
    ORDER BY n.title COLLATE NOCASE
  `),
  deleteVaultEntityFactsForNote: db.prepare(
    "DELETE FROM vault_entity_facts WHERE source_note_id = ?"
  ),
  deleteVaultEntityFactsForEntity: db.prepare("DELETE FROM vault_entity_facts WHERE entity_id = ?"),
  copyVaultEntityFacts: db.prepare(`
    INSERT OR IGNORE INTO vault_entity_facts (entity_id, source_note_id, facts, updated_at)
    SELECT ?, source_note_id, facts, updated_at
    FROM vault_entity_facts WHERE entity_id = ?
  `),

  // ── Brain-call log (Phase G2) ─────────────────────────────────────────────
  insertBrainCall: db.prepare(`
    INSERT INTO brain_calls (id, task_class, provider, intent, ok, fell_back, latency_ms, tokens, error)
    VALUES (@id, @task_class, @provider, @intent, @ok, @fell_back, @latency_ms, @tokens, @error)
  `),
  listBrainCalls: db.prepare(
    "SELECT * FROM brain_calls ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),

  // ── Assistant action log (Phase M) ────────────────────────────────────────
  insertAssistantAction: db.prepare(`
    INSERT INTO assistant_actions (id, action, params_hash, source, risk, outcome, error)
    VALUES (@id, @action, @params_hash, @source, @risk, @outcome, @error)
  `),
  listAssistantActions: db.prepare(
    "SELECT * FROM assistant_actions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),

  // ── Project pulse (Phase G2) ──────────────────────────────────────────────
  upsertPulse: db.prepare(`
    INSERT INTO project_pulse (project_id, state, summary, days_since_activity, open_todos, last_activity_at, computed_at)
    VALUES (@project_id, @state, @summary, @days_since_activity, @open_todos, @last_activity_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(project_id) DO UPDATE SET
      state = excluded.state,
      summary = excluded.summary,
      days_since_activity = excluded.days_since_activity,
      open_todos = excluded.open_todos,
      last_activity_at = excluded.last_activity_at,
      computed_at = excluded.computed_at
  `),
  getPulse: db.prepare("SELECT * FROM project_pulse WHERE project_id = ?"),
  listPulse: db.prepare("SELECT * FROM project_pulse ORDER BY days_since_activity DESC"),
  deletePulse: db.prepare("DELETE FROM project_pulse WHERE project_id = ?"),

  // ── Skill runs (Phase H) ──────────────────────────────────────────────────
  insertSkillRun: db.prepare(`
    INSERT INTO skill_runs (id, skill_id, skill_name, trigger, status, params, steps)
    VALUES (@id, @skill_id, @skill_name, @trigger, 'running', @params, @steps)
  `),
  getSkillRun: db.prepare("SELECT * FROM skill_runs WHERE id = ?"),
  listSkillRuns: db.prepare(
    "SELECT * FROM skill_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  listSkillRunsBySkill: db.prepare(
    "SELECT * FROM skill_runs WHERE skill_id = ? ORDER BY started_at DESC, id DESC LIMIT ?"
  ),
  listRunningSkillRuns: db.prepare("SELECT * FROM skill_runs WHERE status = 'running'"),
  updateSkillRunSteps: db.prepare("UPDATE skill_runs SET steps = ? WHERE id = ?"),
  finishSkillRun: db.prepare(
    "UPDATE skill_runs SET status = ?, error = ?, steps = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'running'"
  ),

  // ── GitHub dev-workflow panel (Phase I) ───────────────────────────────────
  getGithubCache: db.prepare("SELECT * FROM github_cache WHERE id = 1"),
  upsertGithubCache: db.prepare(`
    INSERT INTO github_cache (id, data, fingerprint, fetched_at, error)
    VALUES (1, @data, @fingerprint, @fetched_at, @error)
    ON CONFLICT(id) DO UPDATE SET
      data = @data, fingerprint = @fingerprint, fetched_at = @fetched_at, error = @error
  `),

  // ── Monday.com panel (Phase AD) ───────────────────────────────────────────
  getMondayCache: db.prepare("SELECT * FROM monday_cache WHERE id = 1"),
  upsertMondayCache: db.prepare(`
    INSERT INTO monday_cache (id, data, fingerprint, fetched_at, error)
    VALUES (1, @data, @fingerprint, @fetched_at, @error)
    ON CONFLICT(id) DO UPDATE SET
      data = @data, fingerprint = @fingerprint, fetched_at = @fetched_at, error = @error
  `),

  // Proactive briefings (Phase J).
  insertBriefing: db.prepare(`
    INSERT INTO briefings (id, kind, trigger, text, speech, provider, note_id, persona)
    VALUES (@id, @kind, @trigger, @text, @speech, @provider, @note_id, @persona)
  `),
  getBriefing: db.prepare("SELECT * FROM briefings WHERE id = ?"),
  listBriefings: db.prepare(
    "SELECT * FROM briefings ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ),
  latestBriefingByKind: db.prepare(
    "SELECT * FROM briefings WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ),

  // ── Subscriptions / finance tracker (Phase AE) ────────────────────────────
  insertSubscription: db.prepare(`
    INSERT INTO subscriptions (id, name, amount, currency, cadence, cadence_days, next_renewal, category, notes, active)
    VALUES (@id, @name, @amount, @currency, @cadence, @cadence_days, @next_renewal, @category, @notes, @active)
  `),
  getSubscription: db.prepare("SELECT * FROM subscriptions WHERE id = ?"),
  listSubscriptions: db.prepare(
    "SELECT * FROM subscriptions ORDER BY active DESC, next_renewal ASC, name ASC"
  ),
  updateSubscription: db.prepare(`
    UPDATE subscriptions SET
      name = @name, amount = @amount, currency = @currency, cadence = @cadence,
      cadence_days = @cadence_days, next_renewal = @next_renewal, category = @category,
      notes = @notes, active = @active,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id
  `),
  deleteSubscription: db.prepare("DELETE FROM subscriptions WHERE id = ?"),
};

module.exports = { db, stmts, DB_PATH, DEFAULT_PRICING, applyIntroPricing, NOTES_FTS_OK };
