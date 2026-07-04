/**
 * @file github/service.js
 * @description Poll + cache + broadcast layer for the GitHub dev-workflow panel
 * (Phase I). Wraps github/client.fetchOverview with: a single-row SQLite cache
 * (`github_cache`) that survives restarts and serves `GET /api/github` instantly,
 * a change fingerprint so `github_updated` is broadcast only on a real delta
 * (same pattern as update-scheduler), and a deterministic action-needed push
 * (new review request or newly-red CI) gated by the `github` push category.
 *
 * Everything here is fail-safe: a poll error is stored as the overview's `error`
 * string and never throws, so registering this on the shared scheduler can't
 * take the server down.
 *
 * @author Jarvis (Phase I)
 */

const { stmts } = require("../../db");
const client = require("./client");
const config = require("./config");

let inFlight = null;

/** The last cached overview from SQLite (or a fresh empty one). Never throws. */
function getCached() {
  try {
    const row = stmts.getGithubCache.get();
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

/** Stable fingerprint over the user-visible surface (counts + item identity + CI). */
function fingerprint(overview) {
  const pr = (p) => `${p.repo}#${p.number}:${p.ci}:${p.reviewDecision || ""}`;
  const iss = (i) => `${i.repo}#${i.number}`;
  const lat = (l) => `${l.repo}:${l.branch}:${l.date || ""}:${l.message}`;
  return JSON.stringify({
    m: overview.mode,
    c: overview.counts,
    r: (overview.reviewRequested || []).map(pr),
    o: (overview.mine || []).map(pr),
    i: (overview.issues || []).map(iss),
    l: (overview.latest || []).map(lat),
    e: overview.error || null,
  });
}

function persist(overview, fp) {
  try {
    stmts.upsertGithubCache.run({
      data: JSON.stringify(overview),
      fingerprint: fp,
      fetched_at: new Date().toISOString(),
      error: overview.error || null,
    });
  } catch {
    /* best-effort */
  }
}

/** Keys of PRs that need my review / are failing — for the "newly needs action" diff. */
function reviewKeys(overview) {
  return new Set((overview.reviewRequested || []).map((p) => `${p.repo}#${p.number}`));
}
function failingKeys(overview) {
  const red = (list) =>
    (list || []).filter((p) => p.ci === "failure").map((p) => `${p.repo}#${p.number}`);
  return new Set([...red(overview.reviewRequested), ...red(overview.mine)]);
}

function maybePush(deps, prev, next) {
  const push = deps && deps.push;
  const db = deps && deps.db;
  if (!push || !db) return;
  try {
    const prevReview = reviewKeys(prev);
    const newReview = [...reviewKeys(next)].filter((k) => !prevReview.has(k));
    const prevFail = failingKeys(prev);
    const newFail = [...failingKeys(next)].filter((k) => !prevFail.has(k));

    const parts = [];
    if (newReview.length)
      parts.push(`${newReview.length} PR${newReview.length > 1 ? "s" : ""} need review`);
    if (newFail.length) parts.push(`${newFail.length} CI red`);
    if (parts.length === 0) return;

    push.sendPushToAll(db, "GitHub", parts.join(" · "), "/github", "github").catch(() => {});
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch once, diff against the cache, persist, and (on change) broadcast +
 * (on new action-needed) push. Returns the fresh {overview, fetchedAt, error}.
 * De-duped: concurrent callers share one in-flight fetch. Never throws.
 *
 * @param {object} deps { db, broadcast, push } — all optional; broadcast/push
 *   are skipped if absent (e.g. a route-triggered refresh with no WS wiring).
 */
async function pollOnce(deps = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const cfg = config.getConfig();
    if (!cfg.enabled) {
      const empty = client.emptyOverview({ configured: false, mode: client.authMode(cfg) });
      return { overview: empty, fetchedAt: null, error: null };
    }
    const prev = getCached().overview;
    const overview = await client.fetchOverview({ config: cfg });
    const fp = fingerprint(overview);
    const prevFp = fingerprint(prev);
    persist(overview, fp);

    if (fp !== prevFp && deps.broadcast) {
      try {
        deps.broadcast("github_updated", overview);
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
