/**
 * @file finance.js
 * @description Subscriptions / finance tracker (Phase AE). Manual entries plus
 * a paste-to-parse brain assist - deliberately NO bank/Plaid integration
 * (cost, credential risk, YAGNI). The server owns all date math:
 *   - next_renewal (YYYY-MM-DD) rolls forward past-due dates on save and on
 *     the daily tick, month-end clamped (Jan 31 + 1mo = Feb 28/29);
 *   - summary() normalizes every cadence to a monthly burn, grouped by
 *     currency (no FX guessing), plus the renewals due in the next 7 days.
 * The daily tick (shared scheduler, briefings last-fired-stamp pattern) fires
 * one push per subscription renewing within 2 days (category "finance",
 * deduped per renewal date so it can't nag twice about the same renewal).
 *
 * Everything here is fail-safe: a bad row or DB error degrades to "skip",
 * never a crash - same posture as briefings/nudges.
 *
 * @author Jarvis (Phase AE)
 */

const { randomUUID } = require("node:crypto");
const { db, stmts } = require("../db");

const CADENCES = ["monthly", "yearly", "custom"];
// ponytail: average month length for normalizing custom cadences to a monthly
// burn - close enough for a glanceable total, not an accounting figure.
const DAYS_PER_MONTH = 30.44;
const RENEWAL_WARN_DAYS = 2;
const TICK_AFTER = "09:00"; // fire the daily renewal check after 9am local
const LAST_TICK_KEY = "finance_last_renewal_check";

const broadcastFn = () => {
  try {
    return require("../websocket").broadcast;
  } catch {
    return null;
  }
};

// ── Date math (YYYY-MM-DD strings, UTC to stay TZ-stable) ───────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isDateStr(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
}

/** One cadence step forward, month-end clamped for monthly/yearly. */
function addCadence(dateStr, cadence, cadenceDays) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  if (cadence === "custom") {
    dt.setUTCDate(dt.getUTCDate() + Math.max(1, Math.floor(cadenceDays || 30)));
  } else {
    const day = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + (cadence === "yearly" ? 12 : 1));
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, lastDay));
  }
  return dt.toISOString().slice(0, 10);
}

/** Roll a renewal date forward until it's today or later. Bounded so a
 *  corrupt ancient date can't spin. */
function rollForward(dateStr, cadence, cadenceDays) {
  if (!isDateStr(dateStr)) return dateStr;
  const today = todayStr();
  let d = dateStr;
  for (let i = 0; i < 1200 && d < today; i++) {
    d = addCadence(d, cadence, cadenceDays);
  }
  return d;
}

/** Whole days from today to the given date (negative = past). */
function daysUntil(dateStr) {
  return Math.round(
    (Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86400000
  );
}

// ── Validation / normalization ───────────────────────────────────────────────

/**
 * Normalize a create/update payload over an existing row (or defaults).
 * Returns { ok, error } | { ok, row } - never throws.
 */
function normalize(input, existing = null) {
  const base = existing || {
    id: randomUUID(),
    name: "",
    amount: NaN,
    currency: "GBP",
    cadence: "monthly",
    cadence_days: null,
    next_renewal: null,
    category: null,
    notes: null,
    active: 1,
  };
  const p = input || {};
  const row = { ...base };

  if (p.name !== undefined) row.name = String(p.name).trim();
  if (!row.name) return { ok: false, error: "name is required" };

  if (p.amount !== undefined) row.amount = Number(p.amount);
  if (!Number.isFinite(row.amount) || row.amount <= 0) {
    return { ok: false, error: "amount must be a positive number" };
  }

  if (p.currency !== undefined) row.currency = String(p.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(row.currency))
    return { ok: false, error: "currency must be a 3-letter code" };

  if (p.cadence !== undefined) row.cadence = String(p.cadence);
  if (!CADENCES.includes(row.cadence)) {
    return { ok: false, error: `cadence must be one of ${CADENCES.join(", ")}` };
  }
  if (p.cadence_days !== undefined) {
    row.cadence_days = p.cadence_days == null ? null : Math.floor(Number(p.cadence_days));
  }
  if (row.cadence === "custom" && (!row.cadence_days || row.cadence_days < 1)) {
    return { ok: false, error: "cadence_days (>= 1) is required for a custom cadence" };
  }

  if (p.next_renewal !== undefined) row.next_renewal = p.next_renewal || null;
  if (row.next_renewal != null && !isDateStr(row.next_renewal)) {
    return { ok: false, error: "next_renewal must be a YYYY-MM-DD date" };
  }
  // No date given → first renewal is one cadence from today. A past date rolls
  // forward - the tracker cares about the NEXT renewal, history isn't stored.
  if (!row.next_renewal) row.next_renewal = addCadence(todayStr(), row.cadence, row.cadence_days);
  else row.next_renewal = rollForward(row.next_renewal, row.cadence, row.cadence_days);

  if (p.category !== undefined) row.category = p.category ? String(p.category).trim() : null;
  if (p.notes !== undefined) row.notes = p.notes ? String(p.notes).trim() : null;
  if (p.active !== undefined) row.active = p.active ? 1 : 0;

  return { ok: true, row };
}

// ── CRUD (thin over stmts; broadcasts subscriptions_updated) ────────────────

function list() {
  try {
    return stmts.listSubscriptions.all();
  } catch {
    return [];
  }
}

function create(input) {
  const v = normalize(input);
  if (!v.ok) return v;
  stmts.insertSubscription.run(v.row);
  emitUpdated();
  return { ok: true, row: stmts.getSubscription.get(v.row.id) };
}

function updateParams(row) {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    cadence: row.cadence,
    cadence_days: row.cadence_days,
    next_renewal: row.next_renewal,
    category: row.category,
    notes: row.notes,
    active: row.active,
  };
}

function update(id, patch) {
  const existing = stmts.getSubscription.get(id);
  if (!existing) return { ok: false, error: "not found", notFound: true };
  const v = normalize(patch, existing);
  if (!v.ok) return v;
  stmts.updateSubscription.run(updateParams(v.row));
  emitUpdated();
  return { ok: true, row: stmts.getSubscription.get(id) };
}

function remove(id) {
  const existing = stmts.getSubscription.get(id);
  if (!existing) return { ok: false, error: "not found", notFound: true };
  stmts.deleteSubscription.run(id);
  emitUpdated();
  return { ok: true };
}

function emitUpdated() {
  const b = broadcastFn();
  if (b) {
    try {
      b("subscriptions_updated", { at: new Date().toISOString() });
    } catch {
      /* best-effort */
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

/** Monthly-equivalent amount for one subscription. */
function monthlyAmount(sub) {
  if (sub.cadence === "yearly") return sub.amount / 12;
  if (sub.cadence === "custom") {
    return sub.amount * (DAYS_PER_MONTH / Math.max(1, sub.cadence_days || 30));
  }
  return sub.amount;
}

/**
 * Glanceable rollup: per-currency monthly burn + yearly projection (no FX
 * conversion - mixed currencies stay separate), renewals in the next 7 days,
 * and the single soonest renewal.
 */
function summary() {
  const subs = list().filter((s) => s.active);
  const byCurrency = {};
  for (const s of subs) {
    const c = (byCurrency[s.currency] ||= { monthly_burn: 0, yearly_projection: 0, count: 0 });
    c.monthly_burn += monthlyAmount(s);
    c.count += 1;
  }
  for (const c of Object.values(byCurrency)) {
    c.monthly_burn = Math.round(c.monthly_burn * 100) / 100;
    c.yearly_projection = Math.round(c.monthly_burn * 12 * 100) / 100;
  }
  const upcoming = subs
    .filter((s) => isDateStr(s.next_renewal))
    .map((s) => ({ ...s, days_until: daysUntil(s.next_renewal) }))
    .filter((s) => s.days_until >= 0 && s.days_until <= 7)
    .sort((a, b) => a.days_until - b.days_until);
  const next = subs
    .filter((s) => isDateStr(s.next_renewal))
    .sort((a, b) => (a.next_renewal < b.next_renewal ? -1 : 1))[0];
  return {
    active_count: subs.length,
    by_currency: byCurrency,
    upcoming,
    next_renewal: next
      ? {
          id: next.id,
          name: next.name,
          amount: next.amount,
          currency: next.currency,
          date: next.next_renewal,
          days_until: daysUntil(next.next_renewal),
        }
      : null,
  };
}

/** Renewals within `days` (used by briefings). Never throws. */
function renewalsWithin(days) {
  try {
    return list()
      .filter((s) => s.active && isDateStr(s.next_renewal))
      .map((s) => ({ ...s, days_until: daysUntil(s.next_renewal) }))
      .filter((s) => s.days_until >= 0 && s.days_until <= days)
      .sort((a, b) => a.days_until - b.days_until);
  } catch {
    return [];
  }
}

// ── Paste-to-parse brain assist ──────────────────────────────────────────────

const PARSE_SYSTEM =
  "Extract recurring subscriptions from the user's pasted text (bank statement " +
  "lines, receipts, an app list, prose). Return ONLY a JSON array; each item: " +
  '{"name": string, "amount": number, "currency": 3-letter code (guess from ' +
  'symbols, default "GBP"), "cadence": "monthly"|"yearly", "category": short ' +
  "string or null}. One item per DISTINCT subscription (dedupe repeated " +
  "charges). Skip one-off purchases. No prose, no markdown fence.";

/**
 * Parse a pasted blob into candidate subscriptions for confirm-before-save
 * (same raw→formatted confirm UX as the G2 dump flow). Uses the brain when a
 * provider is configured; degrades to a line/amount heuristic. Never throws.
 */
async function parseCandidates(text) {
  const raw = String(text || "").trim();
  if (!raw) return { candidates: [], formatted: false, provider: null };

  const router = require("./brain/router");
  if (router.anyProviderConfigured()) {
    try {
      const { text: out, provider } = await router.complete({
        prompt: raw,
        system: PARSE_SYSTEM,
        taskClass: "standard",
        intent: "finance_parse",
      });
      const parsed = parseJsonArray(out);
      if (parsed) {
        const candidates = parsed
          .map((c) => normalize({ ...c, next_renewal: null }))
          .filter((v) => v.ok)
          .map((v) => pickCandidate(v.row))
          .slice(0, 50);
        return { candidates, formatted: true, provider };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  return { candidates: heuristicCandidates(raw), formatted: false, provider: null };
}

function pickCandidate(row) {
  const { name, amount, currency, cadence, cadence_days, category } = row;
  return { name, amount, currency, cadence, cadence_days, category };
}

// Lines that look like "<label> ... <amount>" - a currency symbol/code near a
// number. Good enough to seed the confirm list without a model.
function heuristicCandidates(raw) {
  const out = [];
  const seen = new Set();
  const SYMBOLS = { "£": "GBP", $: "USD", "€": "EUR", "₺": "TRY" };
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(
      /([£$€₺])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(GBP|USD|EUR|TRY)/i
    );
    if (!m) continue;
    const amount = parseFloat((m[2] || m[3] || "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const currency = m[1] ? SYMBOLS[m[1]] : (m[4] || "GBP").toUpperCase();
    const name = line
      .replace(m[0], "")
      .replace(/\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, amount, currency, cadence: "monthly", cadence_days: null, category: null });
    if (out.length >= 50) break;
  }
  return out;
}

function parseJsonArray(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("[")) {
    const first = s.indexOf("[");
    const last = s.lastIndexOf("]");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// ── Daily tick (shared scheduler; briefings last-fired-stamp pattern) ────────

function schedMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * One shared-scheduler tick (60s cadence). Once per day after TICK_AFTER:
 * roll past-due renewals forward, then push for anything renewing within
 * RENEWAL_WARN_DAYS. Idempotent per day via a persisted stamp; each push is
 * deduped per subscription+renewal-date by the notify facade.
 */
function tick() {
  try {
    const stamp = todayStr();
    const row = stmts.getSetting.get(LAST_TICK_KEY);
    if (row && row.value === stamp) return;
    const d = new Date();
    if (d.getHours() * 60 + d.getMinutes() < schedMinutes(TICK_AFTER)) return;
    stmts.setSetting.run(LAST_TICK_KEY, stamp); // mark BEFORE the work: no double-fire

    // Roll past-due renewals forward (the subscription renewed; next one is due).
    let rolled = 0;
    for (const s of list()) {
      if (!s.active || !isDateStr(s.next_renewal)) continue;
      const next = rollForward(s.next_renewal, s.cadence, s.cadence_days);
      if (next !== s.next_renewal) {
        stmts.updateSubscription.run(updateParams({ ...s, next_renewal: next }));
        rolled += 1;
      }
    }
    if (rolled > 0) emitUpdated();

    for (const s of renewalsWithin(RENEWAL_WARN_DAYS)) {
      try {
        require("./notify").notify({
          category: "finance",
          title: `${s.name} renews ${s.days_until === 0 ? "today" : s.days_until === 1 ? "tomorrow" : `in ${s.days_until} days`}`,
          body: `${s.amount.toFixed(2)} ${s.currency} · ${s.cadence}${s.category ? ` · ${s.category}` : ""}`,
          url: "/finance",
          data: { subscriptionId: s.id },
          source: "finance",
          dedupeKey: `renewal-${s.id}-${s.next_renewal}`,
        });
      } catch {
        /* best-effort per subscription */
      }
    }
  } catch (err) {
    console.warn("[finance] renewal tick failed:", err?.message || err);
  }
}

module.exports = {
  list,
  create,
  update,
  remove,
  summary,
  renewalsWithin,
  parseCandidates,
  tick,
  // exported for tests
  addCadence,
  rollForward,
  monthlyAmount,
  normalize,
  heuristicCandidates,
  LAST_TICK_KEY,
};
