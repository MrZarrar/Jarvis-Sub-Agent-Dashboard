/**
 * @file monday/service.js
 * @description Poll + cache + broadcast layer for the Monday.com panel (Phase
 * AD) - a deliberate 1:1 clone of github/service.js. Wraps monday/client
 * .fetchOverview with: a single-row SQLite cache (`monday_cache`) that survives
 * restarts and serves `GET /api/monday` instantly, a change fingerprint so
 * `monday_updated` is broadcast only on a real delta, and a deterministic
 * action-needed push (item newly assigned to me / newly due today) gated by the
 * `monday` push category.
 *
 * Everything here is fail-safe: a poll error is stored as the overview's `error`
 * string and never throws, so registering this on the shared scheduler can't
 * take the server down.
 *
 * @author Jarvis (Phase AD)
 */

const { stmts } = require("../../db");
const client = require("./client");
const config = require("./config");

let inFlight = null;

/** The last cached overview from SQLite (or a fresh empty one). Never throws. */
function getCached() {
  try {
    const row = stmts.getMondayCache.get();
    if (row && row.data) {
      const overview = JSON.parse(row.data);
      return {
        overview,
        fetchedAt: row.fetched_at || null,
        error: row.error || overview.error || null,
      };
    }
  } catch {
    /* fall through to empty */
  }
  return { overview: client.emptyOverview(), fetchedAt: null, error: null };
}

/** Stable fingerprint over the user-visible surface (counts + item identity + status). */
function fingerprint(overview) {
  const it = (i) => `${i.boardId}#${i.id}:${i.status || ""}:${i.dueDate || ""}`;
  return JSON.stringify({
    c: overview.counts,
    m: (overview.mine || []).map(it),
    d: (overview.dueToday || []).map(it),
    o: (overview.overdue || []).map(it),
    r: (overview.recent || []).map(it),
    e: overview.error || null,
  });
}

function persist(overview, fp) {
  try {
    stmts.upsertMondayCache.run({
      data: JSON.stringify(overview),
      fingerprint: fp,
      fetched_at: new Date().toISOString(),
      error: overview.error || null,
    });
  } catch {
    /* best-effort */
  }
}

const mineKeys = (ov) => new Set((ov.mine || []).map((i) => `${i.boardId}#${i.id}`));
const dueKeys = (ov) => new Set((ov.dueToday || []).map((i) => `${i.boardId}#${i.id}`));

function maybePush(deps, prev, next) {
  const push = deps && deps.push;
  const db = deps && deps.db;
  if (!push || !db) return;
  try {
    const prevMine = mineKeys(prev);
    const newMine = (next.mine || []).filter((i) => !prevMine.has(`${i.boardId}#${i.id}`));
    const prevDue = dueKeys(prev);
    const newDue = (next.dueToday || []).filter((i) => !prevDue.has(`${i.boardId}#${i.id}`));

    // Exact copy (Phase O posture): name the items, don't just count them.
    const names = (list) =>
      list
        .slice(0, 4)
        .map((i) => i.name)
        .join(", ") + (list.length > 4 ? ", …" : "");
    const parts = [];
    if (newMine.length) parts.push(`Assigned to you: ${names(newMine)}`);
    if (newDue.length) parts.push(`Due today: ${names(newDue)}`);
    if (parts.length === 0) return;

    const total = newMine.length + newDue.length;
    require("../notify").notify({
      category: "monday",
      title: `${total} Monday item${total > 1 ? "s" : ""} need${total > 1 ? "" : "s"} you`,
      body: parts.join(" · "),
      url: "/monday",
      data: {
        assigned: newMine.map((i) => i.id),
        dueToday: newDue.map((i) => i.id),
      },
      source: "monday",
      dedupeKey: "monday:action-needed",
      escalate: true,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch once, diff against the cache, persist, and (on change) broadcast +
 * (on new action-needed) push. Returns the fresh {overview, fetchedAt, error}.
 * De-duped: concurrent callers share one in-flight fetch. Never throws.
 *
 * @param {object} deps { db, broadcast, push } - all optional; broadcast/push
 *   are skipped if absent (e.g. a route-triggered refresh with no WS wiring).
 */
async function pollOnce(deps = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const cfg = config.getConfig();
    if (!cfg.enabled) {
      const empty = client.emptyOverview({ configured: false });
      return { overview: empty, fetchedAt: null, error: null };
    }
    const prev = getCached().overview;
    const overview = await client.fetchOverview({ config: cfg });
    const fp = fingerprint(overview);
    const prevFp = fingerprint(prev);
    persist(overview, fp);

    if (fp !== prevFp && deps.broadcast) {
      try {
        deps.broadcast("monday_updated", overview);
      } catch {
        /* best-effort */
      }
    }
    maybePush(deps, prev, overview);
    return { overview, fetchedAt: new Date().toISOString(), error: overview.error || null };
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = { getCached, pollOnce, fingerprint };
