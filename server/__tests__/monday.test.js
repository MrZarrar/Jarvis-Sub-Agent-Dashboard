/**
 * @file monday.test.js
 * @description Unit + integration tests for the Monday.com panel (Phase AD),
 * mirroring github.test.js: config read/redact/update (token redaction,
 * pollMinutes clamp, doneLabel), the client's item shaping via an injected
 * fetch (no real Monday/network), the service cache round-trip + fingerprint +
 * broadcast-on-change, and route CRUD. Node's built-in test runner + a temp DB.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "monday-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.MONDAY_CONFIG_PATH = path.join(TMP, "monday.json");
// Keep env fallbacks from leaking real values into these tests.
delete process.env.MONDAY_TOKEN;

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const config = require("../lib/monday/config");
const client = require("../lib/monday/client");
const service = require("../lib/monday/service");

let server;
let BASE;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** A fake fetch resolving one GraphQL data payload. */
function gqlFetch(data) {
  return async () => ({ ok: true, json: async () => ({ data }) });
}

const TODAY = client.localToday();

function fixtureBoards() {
  return {
    me: { id: "77", name: "Mushaf" },
    boards: [
      {
        id: "100",
        name: "Life",
        url: "https://acc.monday.com/boards/100",
        type: "board",
        items_page: {
          items: [
            {
              id: "1",
              name: "Pay rent",
              updated_at: "2026-07-01T00:00:00Z",
              group: { title: "Chores" },
              column_values: [
                { id: "date", type: "date", text: "2020-01-01", value: null },
                { id: "status", type: "status", text: "Working on it", value: null },
                {
                  id: "person",
                  type: "people",
                  text: "Mushaf",
                  value: JSON.stringify({ personsAndTeams: [{ id: 77, kind: "person" }] }),
                },
              ],
            },
            {
              id: "2",
              name: "Call dentist",
              updated_at: "2026-07-09T00:00:00Z",
              group: { title: "Chores" },
              column_values: [
                { id: "date", type: "date", text: TODAY, value: null },
                { id: "status", type: "status", text: null, value: null },
              ],
            },
            {
              id: "3",
              name: "Old finished thing",
              updated_at: "2026-06-01T00:00:00Z",
              group: { title: "Chores" },
              column_values: [
                { id: "date", type: "date", text: "2020-01-01", value: null },
                { id: "status", type: "status", text: "Done", value: null },
              ],
            },
          ],
        },
      },
      // Sub-item boards are skipped.
      { id: "101", name: "Subitems of Life", type: "sub_items_board", items_page: { items: [] } },
    ],
  };
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("monday config", () => {
  it("defaults to unconfigured with the token redacted", () => {
    try {
      fs.unlinkSync(config.configPath());
    } catch {
      /* fresh */
    }
    const red = config.redactedConfig();
    assert.equal(red.hasToken, false);
    assert.equal(red.pollMinutes, 5);
    assert.equal(red.enabled, true);
    assert.equal(red.doneLabel, "Done");
  });

  it("persists a patch, redacts the token, and clamps pollMinutes", () => {
    config.updateConfig({ token: "eyJ_secret", pollMinutes: 9999, doneLabel: " Finished " });
    const red = config.redactedConfig();
    assert.equal(red.hasToken, true);
    assert.equal(red.pollMinutes, config.MAX_POLL_MINUTES);
    assert.equal(red.doneLabel, "Finished");
    // The raw token is on disk (server-side) but never in the redacted view.
    assert.equal(config.getConfig().token, "eyJ_secret");
    assert.equal(JSON.stringify(red).includes("eyJ_secret"), false);
  });

  it("clearing the token actually clears it; empty doneLabel falls back", () => {
    config.updateConfig({ token: "", doneLabel: "  " });
    assert.equal(config.getConfig().token, "");
    assert.equal(config.redactedConfig().hasToken, false);
    assert.equal(config.getConfig().doneLabel, "Done");
  });
});

describe("monday client shaping", () => {
  it("returns an unconfigured overview with no token", async () => {
    const ov = await client.fetchOverview({
      config: { enabled: true, token: "", doneLabel: "Done" },
    });
    assert.equal(ov.configured, false);
    assert.equal(ov.counts.mine, 0);
  });

  it("shapes items: mine via people column, due/overdue via date, done via status label", async () => {
    const ov = await client.fetchOverview({
      config: { enabled: true, token: "t", doneLabel: "Done" },
      fetch: gqlFetch(fixtureBoards()),
    });
    assert.equal(ov.configured, true);
    assert.equal(ov.me.id, "77");
    assert.equal(ov.counts.boards, 1); // sub-item board skipped
    assert.equal(ov.boards[0].itemCount, 3);

    // "Pay rent": assigned to me, overdue, not done.
    assert.equal(ov.counts.mine, 1);
    assert.equal(ov.mine[0].name, "Pay rent");
    assert.equal(ov.mine[0].statusColumnId, "status");
    assert.equal(ov.mine[0].url, "https://acc.monday.com/boards/100/pulses/1");

    // Overdue excludes the Done item even though its date is past.
    assert.deepEqual(
      ov.overdue.map((i) => i.name),
      ["Pay rent"]
    );
    assert.deepEqual(
      ov.dueToday.map((i) => i.name),
      ["Call dentist"]
    );
    // Recent is sorted newest-updated first and includes done items.
    assert.equal(ov.recent[0].name, "Call dentist");
    assert.equal(ov.recent.length, 3);
  });

  it("resolves an API error to an overview with an error string (never throws)", async () => {
    const ov = await client.fetchOverview({
      config: { enabled: true, token: "t", doneLabel: "Done" },
      fetch: async () => ({
        ok: true,
        json: async () => ({ errors: [{ message: "Not authenticated" }] }),
      }),
    });
    assert.equal(ov.configured, true);
    assert.equal(ov.error, "Not authenticated");
  });

  it("markDone posts the change_simple_column_value mutation", async () => {
    const calls = [];
    const fetchFn = async (_url, opts) => {
      calls.push(JSON.parse(opts.body));
      return {
        ok: true,
        json: async () => ({ data: { change_simple_column_value: { id: "1" } } }),
      };
    };
    await client.markDone({
      boardId: "100",
      itemId: "1",
      columnId: "status",
      config: { token: "t", doneLabel: "Done" },
      fetch: fetchFn,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].query, /change_simple_column_value/);
    assert.deepEqual(calls[0].variables, { board: "100", item: "1", col: "status", val: "Done" });
  });
});

describe("monday service cache + fingerprint", () => {
  it("round-trips a snapshot through SQLite", () => {
    const snap = client.emptyOverview({
      configured: true,
      counts: { mine: 2, dueToday: 1, overdue: 0, boards: 1 },
    });
    stmts.upsertMondayCache.run({
      data: JSON.stringify(snap),
      fingerprint: service.fingerprint(snap),
      fetched_at: new Date().toISOString(),
      error: null,
    });
    const cached = service.getCached();
    assert.equal(cached.overview.counts.mine, 2);
  });

  it("broadcasts monday_updated only on a fingerprint change", async () => {
    // Seed a distinctive snapshot so the next (tokenless → empty) poll differs.
    const seeded = client.emptyOverview({
      configured: true,
      counts: { mine: 5, dueToday: 5, overdue: 5, boards: 5 },
    });
    stmts.upsertMondayCache.run({
      data: JSON.stringify(seeded),
      fingerprint: service.fingerprint(seeded),
      fetched_at: new Date().toISOString(),
      error: null,
    });
    config.updateConfig({ token: "" }); // no token → fetchOverview short-circuits

    const events = [];
    const broadcast = (type, data) => events.push({ type, data });
    await service.pollOnce({ db, broadcast });
    assert.equal(events.filter((e) => e.type === "monday_updated").length, 1);

    // Second poll: nothing changed → no broadcast.
    events.length = 0;
    await service.pollOnce({ db, broadcast });
    assert.equal(events.filter((e) => e.type === "monday_updated").length, 0);
  });
});

describe("monday routes", () => {
  it("GET /api/monday returns the cached overview", async () => {
    const res = await req("GET", "/api/monday");
    assert.equal(res.status, 200);
    assert.ok(res.body.overview);
    assert.equal(typeof res.body.configured, "boolean");
  });

  it("GET/PUT /api/monday/config updates and redacts the token", async () => {
    const put = await req("PUT", "/api/monday/config", { token: "eyJ_route", doneLabel: "Done" });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.hasToken, true);
    assert.equal(JSON.stringify(put.body).includes("eyJ_route"), false);

    const get = await req("GET", "/api/monday/config");
    assert.equal(get.body.config.hasToken, true);
    // cleanup so a real token env/file doesn't linger
    await req("PUT", "/api/monday/config", { token: "" });
  });

  it("POST /api/monday/refresh returns an overview without throwing", async () => {
    const res = await req("POST", "/api/monday/refresh");
    assert.equal(res.status, 200);
    assert.ok(res.body.overview);
    assert.equal(res.body.overview.configured, false); // token cleared above
  });

  it("POST /api/monday/items/:id/done 404s for an item not in the cache", async () => {
    const res = await req("POST", "/api/monday/items/nope/done", { boardId: "1" });
    assert.equal(res.status, 404);
  });
});
