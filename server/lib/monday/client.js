/**
 * @file monday/client.js
 * @description Monday.com data access for the Monday panel (Phase AD) - the
 * sibling of github/client.js. One backend: GraphQL POSTs to
 * https://api.monday.com/v2 with a personal API token (works on the free plan).
 * All calls are server-side; the token never reaches the client.
 *
 * `fetchOverview` never throws: any API error resolves to an overview with an
 * `error` string so the poller/route can surface it without crashing. The
 * network seam (`fetch`) is injectable so the shaping logic can be unit-tested
 * without a real Monday account.
 *
 * Shape notes (verified against the current v2 API, defensively parsed):
 *   - boards(...) { items_page { items { column_values { id type text value }}}}
 *   - a "people" column's `value` is JSON {"personsAndTeams":[{"id":…}]} -
 *     that's how "my items" are detected (matched against `me.id`).
 *   - a "date" column's `text` is "YYYY-MM-DD" - due/overdue is computed
 *     against the server's local date.
 *   - a "status" column's `text` is its label; `done` = label equals the
 *     configured doneLabel (default "Done", case-insensitive).
 *
 * @author Jarvis (Phase AD)
 */

const { getConfig } = require("./config");

const API_URL = "https://api.monday.com/v2";
const BOARDS_LIMIT = 25;
const ITEMS_PER_BOARD = 100;
const MAX_ITEMS = 50; // cap each list so a huge account can't bloat the snapshot

const OVERVIEW_QUERY = `query {
  me { id name }
  boards (limit: ${BOARDS_LIMIT}, order_by: used_at) {
    id name url type
    items_page (limit: ${ITEMS_PER_BOARD}) {
      items {
        id name updated_at
        group { title }
        column_values { id type text value }
      }
    }
  }
}`;

const MARK_DONE_MUTATION = `mutation ($board: ID!, $item: ID!, $col: String!, $val: String!) {
  change_simple_column_value (board_id: $board, item_id: $item, column_id: $col, value: $val) { id }
}`;

/** POST one GraphQL request. Throws on HTTP or GraphQL errors. */
async function gql(query, variables, { token, fetchFn = fetch } = {}) {
  const res = await fetchFn(API_URL, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && (body.error_message || body.message)) detail = body.error_message || body.message;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const body = await res.json();
  if (body && Array.isArray(body.errors) && body.errors.length) {
    throw new Error(body.errors[0].message || "GraphQL error");
  }
  return (body && body.data) || {};
}

const emptyOverview = (extra = {}) => ({
  configured: false,
  me: null,
  boards: [],
  mine: [],
  dueToday: [],
  overdue: [],
  recent: [],
  counts: { mine: 0, dueToday: 0, overdue: 0, boards: 0 },
  error: null,
  ...extra,
});

/** Local YYYY-MM-DD (due dates are wall-clock dates, not instants). */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whether a people column's raw value contains person `meId`. */
function personInValue(value, meId) {
  if (!value || !meId) return false;
  try {
    const parsed = JSON.parse(value);
    const people = parsed && Array.isArray(parsed.personsAndTeams) ? parsed.personsAndTeams : [];
    return people.some((p) => String(p.id) === String(meId));
  } catch {
    return false;
  }
}

/** Shape one raw item into our compact row. Defensive: unknown/missing column
 *  types simply leave the derived fields null. */
function shapeItem(board, item, meId, doneLabel) {
  let dueDate = null;
  let status = null;
  let statusColumnId = null;
  let mine = false;
  for (const cv of item.column_values || []) {
    if (!dueDate && cv.type === "date" && cv.text && cv.text.trim()) {
      dueDate = cv.text.trim().slice(0, 10);
    }
    if (status == null && cv.type === "status") {
      status = cv.text || null;
      statusColumnId = cv.id || null;
    }
    if (!mine && cv.type === "people" && personInValue(cv.value, meId)) mine = true;
  }
  return {
    id: String(item.id),
    boardId: String(board.id),
    boardName: board.name || "",
    group: (item.group && item.group.title) || null,
    name: item.name || "(untitled)",
    url: board.url ? `${board.url}/pulses/${item.id}` : null,
    updatedAt: item.updated_at || null,
    dueDate,
    status,
    statusColumnId,
    mine,
    done: Boolean(status && doneLabel && status.toLowerCase() === doneLabel.toLowerCase()),
  };
}

/**
 * Build the full overview. Injection points:
 *   opts.config - resolved config (defaults to getConfig()).
 *   opts.fetch  - replaces global fetch (tests).
 * Never throws.
 */
async function fetchOverview(opts = {}) {
  const cfg = opts.config || getConfig();
  if (!cfg.token) return emptyOverview({ configured: false });

  let data;
  try {
    data = await gql(OVERVIEW_QUERY, null, { token: cfg.token, fetchFn: opts.fetch });
  } catch (err) {
    return emptyOverview({ configured: true, error: err.message || String(err) });
  }

  const me = data.me ? { id: String(data.me.id), name: data.me.name || null } : null;
  const boards = [];
  const items = [];
  for (const board of data.boards || []) {
    if (board.type && board.type !== "board") continue; // skip sub-item/doc boards
    const rows = (board.items_page && board.items_page.items) || [];
    boards.push({
      id: String(board.id),
      name: board.name || "",
      url: board.url || null,
      itemCount: rows.length,
    });
    for (const item of rows) items.push(shapeItem(board, item, me && me.id, cfg.doneLabel));
  }

  const today = localToday();
  const open = items.filter((i) => !i.done);
  const byDueThenUpdated = (a, b) =>
    String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) ||
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));

  const mine = open
    .filter((i) => i.mine)
    .sort(byDueThenUpdated)
    .slice(0, MAX_ITEMS);
  const dueToday = open
    .filter((i) => i.dueDate === today)
    .sort(byDueThenUpdated)
    .slice(0, MAX_ITEMS);
  const overdue = open
    .filter((i) => i.dueDate && i.dueDate < today)
    .sort(byDueThenUpdated)
    .slice(0, MAX_ITEMS);
  const recent = [...items]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, MAX_ITEMS);

  return {
    configured: true,
    me,
    boards,
    mine,
    dueToday,
    overdue,
    recent,
    counts: {
      mine: mine.length,
      dueToday: dueToday.length,
      overdue: overdue.length,
      boards: boards.length,
    },
    error: null,
  };
}

/**
 * Write-back minimum (AD §4, needed by the AC board): set an item's status
 * column to the configured done label. Throws on failure - callers surface it.
 */
async function markDone({ boardId, itemId, columnId, config, fetch: fetchFn } = {}) {
  const cfg = config || getConfig();
  if (!cfg.token) throw new Error("Monday is not configured (no token)");
  if (!boardId || !itemId || !columnId)
    throw new Error("boardId, itemId and columnId are required");
  await gql(
    MARK_DONE_MUTATION,
    { board: String(boardId), item: String(itemId), col: String(columnId), val: cfg.doneLabel },
    { token: cfg.token, fetchFn: fetchFn || fetch }
  );
  return { ok: true };
}

module.exports = { fetchOverview, markDone, emptyOverview, shapeItem, localToday };
