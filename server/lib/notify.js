/**
 * @file notify.js
 * @description Phase O (§3.2): the ONE way to notify the user. A facade over
 * push.sendPushToAll that also:
 *
 *   1. persists a row in the `notifications` table (the in-dashboard inbox the
 *      Tabby ball surfaces),
 *   2. broadcasts `notification_created` on the WS (live badge/inbox update),
 *   3. respects the existing per-category push prefs (a muted category is a
 *      full no-op - no push, no row, no broadcast),
 *   4. dedupes: same category + dedupeKey with an UNREAD row updates that row
 *      in place (and re-pushes only when `escalate` is set) instead of
 *      stacking near-duplicates.
 *
 * Every producer (permission requests, nudges, briefings, GitHub, skills,
 * swaps, schedules) routes through here. Copy rules for producers live in
 * docs/NOTIFICATIONS.md - exact names, counts, times, and a deep link, always.
 *
 * Fail-safe: notify() never throws and never blocks the caller - a broken
 * inbox write must not take down a run's teardown. Push delivery is
 * fire-and-forget (same contract sendPushToAll callers always had).
 *
 * @author Jarvis (Phase O)
 */

const { randomUUID } = require("crypto");

// Lazy requires, mirroring the producers' own defensive pattern: this module
// must load (and degrade) in db-less / push-less unit-test environments.
function getDb() {
  try {
    return require("../db").db;
  } catch {
    return null;
  }
}

function getPush() {
  try {
    return require("./push");
  } catch {
    return null;
  }
}

function wsBroadcast(type, data) {
  try {
    require("../websocket").broadcast(type, data);
  } catch {
    /* WS not initialized (tests) - inbox row is still the source of truth */
  }
}

/** Public row shape (data parsed). */
function publicRow(row) {
  let data = {};
  try {
    data = JSON.parse(row.data || "{}");
  } catch {
    data = {};
  }
  return { ...row, data };
}

/**
 * Send a notification everywhere it belongs.
 *
 * @param {object} n
 * @param {string} n.category   Push category key (push.PUSH_CATEGORIES).
 * @param {string} n.title      Exact, entity-naming title.
 * @param {string} [n.body]     Exact body: names, counts, durations, times.
 * @param {string} [n.url]      Deep link to the exact entity.
 * @param {object} [n.data]     Extra entity ids for rich inbox rendering.
 * @param {string} [n.source]   Producer name (for auditing/filtering).
 * @param {string} [n.dedupeKey] Coalesce key, e.g. `run:<id>` - an unread row
 *   with the same category+key is updated in place instead of inserted.
 * @param {boolean} [n.escalate] When coalescing, re-push anyway (severity
 *   went up). New rows always push.
 * @returns {{id: string|null, coalesced: boolean, muted: boolean}}
 */
function notify({ category, title, body, url, data, source, dedupeKey, escalate = false }) {
  const out = { id: null, coalesced: false, muted: false };
  if (!title) return out;
  const db = getDb();
  const push = getPush();

  // Muted category → full no-op (push AND inbox), so the Settings toggle
  // means what it says. Fails open like isCategoryEnabled itself.
  if (db && push && category && !push.isCategoryEnabled(db, category)) {
    out.muted = true;
    return out;
  }

  const payload = JSON.stringify({ ...(data || {}), ...(url ? { url } : {}) });
  let row = null;

  if (db) {
    try {
      if (dedupeKey) {
        const existing = db
          .prepare(
            "SELECT id FROM notifications WHERE category IS ? AND dedupe_key = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1"
          )
          .get(category || null, dedupeKey);
        if (existing) {
          db.prepare(
            "UPDATE notifications SET title = ?, body = ?, data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
          ).run(title, body || null, payload, existing.id);
          out.id = existing.id;
          out.coalesced = true;
        }
      }
      if (!out.id) {
        out.id = randomUUID();
        db.prepare(
          "INSERT INTO notifications (id, category, title, body, data, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          out.id,
          category || null,
          title,
          body || null,
          payload,
          source || null,
          dedupeKey || null
        );
      }
      row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(out.id);
    } catch (err) {
      console.warn("[notify] inbox persist failed:", err?.message || err);
    }
  }

  if (row) wsBroadcast("notification_created", publicRow(row));

  // Push leg: new rows always; coalesced rows only when escalating.
  if (push && db && (!out.coalesced || escalate)) {
    try {
      push.sendPushToAll(db, title, body || "", url, category).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  return out;
}

/** Unread count (badge). Never throws. */
function unreadCount() {
  const db = getDb();
  if (!db) return 0;
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get().n;
  } catch {
    return 0;
  }
}

/** Recent notifications, newest first. unreadOnly filters to read_at IS NULL. */
function list({ unreadOnly = false, limit = 50 } = {}) {
  const db = getDb();
  if (!db) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  try {
    const rows = db
      .prepare(
        `SELECT * FROM notifications ${unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`
      )
      .all(cap);
    return rows.map(publicRow);
  } catch {
    return [];
  }
}

/** Mark one read. Broadcasts notification_read so other devices sync. */
function markRead(id) {
  const db = getDb();
  if (!db || !id) return false;
  try {
    const r = db
      .prepare(
        "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND read_at IS NULL"
      )
      .run(id);
    if (r.changes > 0) wsBroadcast("notification_read", { ids: [id] });
    return r.changes > 0;
  } catch {
    return false;
  }
}

/** Mark everything read. Broadcasts notification_read {all:true}. */
function markAllRead() {
  const db = getDb();
  if (!db) return 0;
  try {
    const r = db
      .prepare(
        "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE read_at IS NULL"
      )
      .run();
    if (r.changes > 0) wsBroadcast("notification_read", { all: true });
    return r.changes;
  } catch {
    return 0;
  }
}

module.exports = { notify, unreadCount, list, markRead, markAllRead };
