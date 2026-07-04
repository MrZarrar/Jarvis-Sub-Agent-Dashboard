/**
 * @file claude-swap.js
 * @description READ-ONLY integration with claude-swap
 * (https://github.com/realiti4/claude-swap), which lets the user run TWO Claude
 * accounts under a single ~/.claude, swapping them in place (auto-swap already
 * configured on the user's machine). The dashboard OBSERVES claude-swap's own
 * state files and surfaces a unified multi-account view - which account is
 * active, each account's reset window when known, and swap history. It NEVER
 * performs a swap itself (v1) and NEVER reads credentials (on macOS those live
 * in the Keychain, not in files).
 *
 * State layout (verified against the claude-swap README 2026-07-04; the actual
 * file shape varies by version, so parsing is deliberately defensive):
 *   ~/.claude-swap-backup/
 *     autoswitch_state.json   ← auto-switch state incl. the active account
 *     settings.json           ← claude-swap settings
 *     sessions/               ← per-account session profiles
 *
 * Everything here is best-effort and fail-safe per repo rules: if claude-swap
 * is absent, or a state file is missing/malformed, the watcher stays quiet and
 * the dashboard behaves exactly as a single implicit account (zero regression
 * for non-swap setups). A watcher error is logged and swallowed - it must never
 * take the server down.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Override for tests / non-default installs. Otherwise the canonical location.
function getSwapBackupDir() {
  return process.env.CLAUDE_SWAP_BACKUP_DIR || path.join(os.homedir(), ".claude-swap-backup");
}

function getStatePath() {
  return path.join(getSwapBackupDir(), "autoswitch_state.json");
}

let started = false;
let watcher = null;
let debounceTimer = null;
let broadcastFn = null;
// Cache the last active account id so getActiveAccountId() is cheap (called on
// every run spawn) and so we can detect swaps without a DB round-trip.
let activeAccountId = null;

const DEBOUNCE_MS = 400;

/**
 * Read + parse the auto-switch state file. Returns a normalized shape:
 *   { active: string|null, accounts: [{ id, label, resetsAt }] }
 * or null when the file is absent/unreadable. Defensive against several plausible
 * key names because the on-disk schema is version-dependent.
 */
function readSwapState() {
  let raw;
  try {
    raw = fs.readFileSync(getStatePath(), "utf8");
  } catch {
    return null; // not installed / not readable
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null; // malformed - treat as absent
  }
  return normalizeState(json);
}

/** Coerce whatever claude-swap wrote into { active, accounts[] }. */
function normalizeState(json) {
  if (!json || typeof json !== "object") return null;

  // Active account under any of the common key names.
  const active =
    firstString(json.active) ||
    firstString(json.active_account) ||
    firstString(json.activeAccount) ||
    firstString(json.current) ||
    firstString(json.current_account) ||
    firstString(json.currentAccount) ||
    null;

  // Accounts may be an array of strings, an array of objects, or an object map.
  const accounts = [];
  const seen = new Set();
  const pushAccount = (id, label, resetsAt) => {
    const key = firstString(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    accounts.push({
      id: key,
      label: firstString(label) || key,
      resetsAt: normalizeResetsAt(resetsAt),
    });
  };

  const src = json.accounts ?? json.profiles ?? json.account_states ?? json.accountStates;
  if (Array.isArray(src)) {
    for (const a of src) {
      if (typeof a === "string") pushAccount(a);
      else if (a && typeof a === "object")
        pushAccount(
          a.id ?? a.name ?? a.email ?? a.account ?? a.label,
          a.label ?? a.name ?? a.email,
          a.resets_at ?? a.resetsAt ?? a.reset ?? a.next_reset ?? a.nextReset
        );
    }
  } else if (src && typeof src === "object") {
    for (const [id, a] of Object.entries(src)) {
      if (a && typeof a === "object")
        pushAccount(
          id,
          a.label ?? a.name ?? a.email,
          a.resets_at ?? a.resetsAt ?? a.reset ?? a.next_reset ?? a.nextReset
        );
      else pushAccount(id);
    }
  }

  // Make sure the active account is represented even if it wasn't in the list.
  if (active && !seen.has(active)) pushAccount(active);

  return { active: active || null, accounts };
}

function firstString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Accept an ISO string or an epoch (seconds or millis) and return ISO or null. */
function normalizeResetsAt(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs millis heuristic
    return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Reconcile the observed state into the DB: upsert every seen account, flip the
 * active flag, and record a swap row when the active account changed. Broadcasts
 * `account_swapped` and fires an optional push. All DB work is guarded.
 */
function syncState(reason = "poll") {
  const state = readSwapState();
  if (!state) return; // claude-swap absent - nothing to do

  let dbMod;
  try {
    dbMod = require("../db");
  } catch {
    return;
  }
  const { db, stmts } = dbMod;

  try {
    // Upsert all known accounts (metadata carries reset info verbatim).
    for (const acct of state.accounts) {
      stmts.upsertAccount.run(
        acct.id,
        acct.label,
        acct.id === state.active ? 1 : 0,
        acct.resetsAt || null,
        null
      );
      if (acct.resetsAt) stmts.setAccountResetsAt.run(acct.resetsAt, acct.id);
    }

    const prevRow = stmts.getActiveAccount.get();
    const prev = prevRow ? prevRow.id : null;
    const next = state.active;

    if (next && next !== prev) {
      // Flip active flag atomically, then record the swap.
      const flip = db.transaction((id) => {
        stmts.clearActiveAccounts.run();
        stmts.setActiveAccount.run(id);
      });
      flip(next);
      stmts.insertAccountSwap.run(prev, next, reason);
      activeAccountId = next;

      const swapped = { from: prev, to: next, reason, at: new Date().toISOString() };
      if (broadcastFn) {
        try {
          broadcastFn("account_swapped", swapped);
        } catch {
          /* best-effort */
        }
      }
      notifySwap(db, prev, next);
    } else if (next) {
      activeAccountId = next;
    }
  } catch (err) {
    console.warn("[claude-swap] state sync failed:", err?.message || err);
  }
}

/** Fire a push for an auto-swap, tagged so the C3 category toggle can mute it. */
function notifySwap(db, from, to) {
  let pushLib;
  try {
    pushLib = require("./push");
  } catch {
    return;
  }
  try {
    const other = from ? stmts_resetLabel(db, from) : null;
    const title = "Account swapped";
    const body = other ? `Now using ${to} - ${other}` : `Now using ${to}`;
    pushLib.sendPushToAll(db, title, body, "/?tab=accounts", "account_swaps").catch(() => {});
  } catch {
    /* best-effort */
  }
}

/** Compose an "acct 1 resets HH:MM" fragment for the previous account, if known. */
function stmts_resetLabel(db, accountId) {
  try {
    const row = db.prepare("SELECT resets_at FROM accounts WHERE id = ?").get(accountId);
    if (row && row.resets_at) {
      const d = new Date(row.resets_at);
      if (!Number.isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${accountId} resets ${hh}:${mm}`;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Full accounts snapshot for the API. `present` is false when claude-swap isn't
 * detected at all, so the UI can hide multi-account chrome entirely.
 */
function getAccountsState() {
  const present = fs.existsSync(getStatePath());
  let accounts = [];
  let swaps = [];
  try {
    const { stmts } = require("../db");
    accounts = stmts.listAccounts.all();
    swaps = stmts.listAccountSwaps.all(20, 0);
  } catch {
    /* DB not ready */
  }
  const active = accounts.find((a) => a.active) || null;
  return {
    present: present || accounts.length > 0,
    activeAccountId: active ? active.id : null,
    accounts,
    swaps,
  };
}

/** Cheap active-account lookup used by run attribution (dashboard-runs.js). */
function getActiveAccountId() {
  if (activeAccountId) return activeAccountId;
  try {
    const { stmts } = require("../db");
    const row = stmts.getActiveAccount.get();
    activeAccountId = row ? row.id : null;
  } catch {
    activeAccountId = null;
  }
  return activeAccountId;
}

function scheduleSync(reason) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    syncState(reason);
  }, DEBOUNCE_MS);
  if (debounceTimer.unref) debounceTimer.unref();
}

/**
 * Start watching claude-swap's autoswitch_state.json for changes. Idempotent.
 * Runs one immediate sync so existing state is picked up at boot. No-op (but
 * safe) when claude-swap isn't installed - the watch simply never fires.
 */
function startClaudeSwapWatcher({ broadcast } = {}) {
  if (started) return;
  started = true;
  broadcastFn = broadcast || null;

  // Immediate reconciliation so the active account is known before the first
  // run is spawned.
  try {
    syncState("startup");
  } catch {
    /* handled inside syncState */
  }

  const dir = getSwapBackupDir();
  try {
    if (!fs.existsSync(dir)) return; // not installed - leave the watcher off
    // Watch the backup DIR (not just the file) so a rewrite that recreates the
    // file - a common atomic-write pattern - still fires an event.
    watcher = fs.watch(dir, (_event, filename) => {
      if (!filename || filename === "autoswitch_state.json") scheduleSync("watch");
    });
    watcher.on("error", () => {});
  } catch {
    /* platform-quirky fs.watch - the poll below is the safety net */
  }

  // Safety-net poll (watchers miss events on some filesystems). Cheap: one
  // stat + parse every 60s. Disable with CLAUDE_SWAP_POLL_MS=0.
  const pollMs = process.env.CLAUDE_SWAP_POLL_MS ? Number(process.env.CLAUDE_SWAP_POLL_MS) : 60_000;
  if (Number.isFinite(pollMs) && pollMs > 0) {
    const timer = setInterval(() => syncState("poll"), pollMs);
    if (timer.unref) timer.unref();
    // Store on the watcher slot's sibling so stop() can clear it.
    startClaudeSwapWatcher._poll = timer;
  }
}

function stopClaudeSwapWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (startClaudeSwapWatcher._poll) {
    clearInterval(startClaudeSwapWatcher._poll);
    startClaudeSwapWatcher._poll = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  started = false;
  broadcastFn = null;
}

module.exports = {
  startClaudeSwapWatcher,
  stopClaudeSwapWatcher,
  getAccountsState,
  getActiveAccountId,
  readSwapState,
  normalizeState,
  syncState,
  getSwapBackupDir,
  getStatePath,
};
