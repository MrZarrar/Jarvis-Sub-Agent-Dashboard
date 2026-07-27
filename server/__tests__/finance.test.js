/**
 * @file finance.test.js
 * @description Tests for the subscriptions / finance tracker (Phase AE): the
 * month-end-clamped date math, payload validation, the per-currency summary
 * rollup, the CRUD REST surface, the deterministic paste-to-parse heuristic
 * (providers are disabled so no model call happens), and the once-per-day
 * renewal tick (roll-forward + finance push, deduped). Node's built-in test
 * runner with a temp DB, mirroring briefings.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "finance-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
// Disable every provider so parseCandidates exercises its deterministic
// heuristic - tests never make a network/spawn call.
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({
    groq: { enabled: false, apiKey: "" },
    gemini: { enabled: false, apiKey: "" },
    ollama: { enabled: false },
    claude: { enabled: false },
    codex: { enabled: false },
    openai: { enabled: false },
  })
);

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const finance = require("../lib/finance");

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

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

describe("date math", () => {
  it("clamps month-end when adding a month (Jan 31 → Feb 28/29)", () => {
    assert.equal(finance.addCadence("2026-01-31", "monthly"), "2026-02-28");
    assert.equal(finance.addCadence("2028-01-31", "monthly"), "2028-02-29"); // leap
    assert.equal(finance.addCadence("2026-03-15", "monthly"), "2026-04-15");
  });

  it("adds a year for yearly and N days for custom", () => {
    assert.equal(finance.addCadence("2026-07-10", "yearly"), "2027-07-10");
    assert.equal(finance.addCadence("2026-07-10", "custom", 14), "2026-07-24");
  });

  it("rolls a past date forward to today-or-later", () => {
    const rolled = finance.rollForward("2020-01-05", "monthly");
    assert.ok(rolled >= todayStr(), `${rolled} should be >= today`);
    // A future date is untouched.
    const future = todayStr(30);
    assert.equal(finance.rollForward(future, "monthly"), future);
  });
});

describe("validation + summary", () => {
  it("rejects bad payloads with clear errors", () => {
    assert.equal(finance.normalize({}).ok, false);
    assert.equal(finance.normalize({ name: "X", amount: -5 }).ok, false);
    assert.equal(finance.normalize({ name: "X", amount: 5, currency: "pounds" }).ok, false);
    assert.equal(finance.normalize({ name: "X", amount: 5, cadence: "weekly" }).ok, false);
    assert.equal(finance.normalize({ name: "X", amount: 5, cadence: "custom" }).ok, false);
  });

  it("normalizes a monthly-burn summary per currency (yearly / custom included)", () => {
    const a = finance.create({ name: "Netflix", amount: 12, currency: "gbp" });
    const b = finance.create({ name: "Domain", amount: 24, currency: "GBP", cadence: "yearly" });
    const c = finance.create({
      name: "VPS",
      amount: 10,
      currency: "USD",
      cadence: "custom",
      cadence_days: 30,
    });
    assert.ok(a.ok && b.ok && c.ok);
    const s = finance.summary();
    assert.equal(s.active_count, 3);
    // 12 (monthly) + 24/12 (yearly) = 14 GBP/month.
    assert.equal(s.by_currency.GBP.monthly_burn, 14);
    assert.equal(s.by_currency.GBP.yearly_projection, 168);
    // Custom 30-day: 10 * 30.44/30 ≈ 10.15 - and currencies never mix.
    assert.ok(Math.abs(s.by_currency.USD.monthly_burn - 10.15) < 0.01);
    assert.ok(s.next_renewal, "soonest renewal is surfaced");
    // Cleanup for later suites.
    for (const sub of finance.list()) finance.remove(sub.id);
  });
});

describe("REST surface", () => {
  let id;

  it("creates (defaulting next_renewal one cadence out) and lists", async () => {
    const res = await req("POST", "/api/subscriptions", {
      name: "Spotify",
      amount: 11.99,
      currency: "GBP",
    });
    assert.equal(res.status, 201);
    id = res.body.subscription.id;
    assert.ok(res.body.subscription.next_renewal > todayStr(), "defaults one cadence from today");
    const list = await req("GET", "/api/subscriptions");
    assert.equal(list.status, 200);
    assert.equal(list.body.subscriptions.length, 1);
  });

  it("rejects invalid input with a 400", async () => {
    const res = await req("POST", "/api/subscriptions", { name: "", amount: 1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_SUBSCRIPTION");
  });

  it("updates partially and rolls a past renewal forward", async () => {
    const res = await req("PUT", `/api/subscriptions/${id}`, {
      amount: 12.99,
      next_renewal: "2020-01-01",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.amount, 12.99);
    assert.ok(res.body.subscription.next_renewal >= todayStr());
  });

  it("parses a pasted blob into candidates via the heuristic (no provider)", async () => {
    const res = await req("POST", "/api/subscriptions/parse", {
      text: "10/06 NETFLIX.COM £9.99\n11/06 Coffee shop £3.20\nAWS 12.50 USD",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.formatted, false);
    assert.ok(res.body.candidates.length >= 2);
    const netflix = res.body.candidates.find((c) => /netflix/i.test(c.name));
    assert.ok(netflix);
    assert.equal(netflix.amount, 9.99);
    assert.equal(netflix.currency, "GBP");
  });

  it("deletes and 404s on unknown ids", async () => {
    assert.equal((await req("DELETE", `/api/subscriptions/${id}`)).status, 200);
    assert.equal((await req("DELETE", `/api/subscriptions/${id}`)).status, 404);
    assert.equal((await req("PUT", "/api/subscriptions/nope", { amount: 1 })).status, 404);
  });
});

describe("daily renewal tick", () => {
  it("rolls past-due dates forward and pushes for renewals within 2 days, once per day", () => {
    const made = finance.create({ name: "iCloud", amount: 2.99, currency: "GBP" });
    assert.ok(made.ok);
    // Force a renewal for tomorrow + a stale past-due date on a second row.
    db.prepare("UPDATE subscriptions SET next_renewal = ? WHERE id = ?").run(
      todayStr(1),
      made.row.id
    );
    const stale = finance.create({ name: "Old", amount: 5, currency: "GBP" });
    db.prepare("UPDATE subscriptions SET next_renewal = '2020-01-01' WHERE id = ?").run(
      stale.row.id
    );
    // Clear the last-fired stamp; freeze "after 9am" by only asserting when
    // the wall clock allows the tick to run (before 9am it's a no-op by design).
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(finance.LAST_TICK_KEY);
    finance.tick();
    const now = new Date();
    const after9 = now.getHours() >= 9;
    const rows = db.prepare("SELECT * FROM subscriptions").all();
    const oldRow = rows.find((r) => r.name === "Old");
    if (after9) {
      assert.ok(oldRow.next_renewal >= todayStr(), "past-due renewal rolled forward");
      const notes = db.prepare("SELECT * FROM notifications WHERE category = 'finance'").all();
      assert.ok(notes.length >= 1, "a finance push landed for the imminent renewal");
      // Second tick the same day is a no-op (stamped).
      const countBefore = db.prepare("SELECT COUNT(*) c FROM notifications").get().c;
      finance.tick();
      assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications").get().c, countBefore);
    } else {
      assert.equal(oldRow.next_renewal, "2020-01-01", "tick waits until after 9am");
    }
    const stampRow = stmts.getSetting.get(finance.LAST_TICK_KEY);
    if (after9) assert.ok(stampRow, "last-fired stamp persisted");
  });
});
