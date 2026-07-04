/**
 * @file scheduler.js
 * @description Persistent scheduler for deferred & chained prompts (Phase L).
 * Two trigger kinds:
 *   - 'at'               — fire at a wall-clock timestamp (setTimeout-armed).
 *   - 'on_run_complete'  — fire when a watched run reaches a terminal status,
 *                          driven by run-spawner's onRunStatus hook (no polling).
 * Two target kinds:
 *   - 'new_run'          — spawn a fresh claude run with the opts captured at
 *                          schedule time (goes through the normal spawn path so
 *                          permission gating, envelopes, and WS broadcasts all
 *                          apply — nothing bespoke).
 *   - 'session_message'  — deliver the prompt into a live run via run-spawner's
 *                          sendInput (the same path /api/run/:id/message uses).
 *
 * Design goals (repo rules): survive restarts (pending schedules re-arm from
 * SQLite on boot; a missed 'at' time fires immediately with a `late` flag), and
 * be strictly fail-safe — a scheduler crash must never take down the server or
 * the run it was watching. Every firing is guarded; every DB touch is guarded.
 *
 * This is THE shared scheduler G2 (daily brain task) and H5 (skill cron) reuse:
 * `registerDueCallback(kind, fn)` lets later phases add their own target kinds
 * without touching this file's firing loop.
 */

const { randomUUID } = require("node:crypto");

// Chain-depth guard: a fired run may itself be the trigger of another schedule
// (queue part 4, 5, 6 up front). Bound the chain so a self-referential mistake
// can't spawn unboundedly.
const MAX_CHAIN_DEPTH = 20;

// setTimeout takes a 32-bit ms delay; anything larger overflows and fires
// immediately. Cap a single arm at ~24 days and re-arm past that.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

let deps = null; // { db, stmts, broadcast, runs, push }
let started = false;
let unsubscribeRunStatus = null;
const timers = new Map(); // scheduleId → Timeout (for 'at' triggers)

// Extension point: later phases register a target-kind handler here. The two
// built-ins ('new_run', 'session_message') are registered in start().
const dueCallbacks = new Map(); // target_kind → async (schedule) → { resultRunId }

function registerDueCallback(kind, fn) {
  if (kind && typeof fn === "function") dueCallbacks.set(kind, fn);
}

/**
 * Bring the scheduler up: wire built-in target handlers, subscribe to run-status
 * transitions, and re-arm every pending schedule from the DB. Idempotent.
 */
function startScheduler({ db, stmts, broadcast, runs, push } = {}) {
  if (started) return;
  deps = { db, stmts, broadcast, runs, push };
  started = true;

  registerDueCallback("new_run", fireNewRun);
  registerDueCallback("session_message", fireSessionMessage);

  // Completion triggers — driven, not polled.
  if (runs && typeof runs.onRunStatus === "function") {
    unsubscribeRunStatus = runs.onRunStatus(onRunTerminal);
  }

  reArmPending();
}

function stopScheduler() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  if (unsubscribeRunStatus) {
    try {
      unsubscribeRunStatus();
    } catch {
      /* ignore */
    }
    unsubscribeRunStatus = null;
  }
  started = false;
}

/** Re-arm all pending 'at' schedules from SQLite on boot. A missed time fires
 *  immediately with `late`. 'on_run_complete' schedules need no arming — they
 *  wait on the run-status hook (and if that run already finished while we were
 *  down, it will never fire again; that's acceptable and documented). */
function reArmPending() {
  let rows = [];
  try {
    rows = deps.stmts.listPendingSchedules.all();
  } catch {
    return;
  }
  for (const row of rows) {
    if (row.trigger_kind === "at") armAtTimer(row);
  }
}

function armAtTimer(row) {
  if (timers.has(row.id)) return;
  const fireAtMs = row.fire_at ? Date.parse(row.fire_at) : NaN;
  if (!Number.isFinite(fireAtMs)) return;
  const delay = fireAtMs - Date.now();
  const late = delay <= 0;
  const clamped = Math.max(0, Math.min(delay, MAX_TIMEOUT_MS));

  const t = setTimeout(() => {
    timers.delete(row.id);
    // Re-arm if we only did a partial wait for a very distant schedule.
    if (delay > MAX_TIMEOUT_MS) {
      const fresh = safeGet(row.id);
      if (fresh && fresh.status === "pending") armAtTimer(fresh);
      return;
    }
    fireSchedule(row.id, { late });
  }, clamped);
  if (t.unref) t.unref();
  timers.set(row.id, t);
}

/** Run-status subscriber: fire any pending on_run_complete schedules watching
 *  this run, respecting the success-only filter. */
function onRunTerminal(payload) {
  if (!payload || !payload.id) return;
  let rows = [];
  try {
    rows = deps.stmts.listPendingSchedulesForRun.all(payload.id);
  } catch {
    return;
  }
  const succeeded =
    payload.status === "completed" && (payload.exitCode === 0 || payload.exitCode == null);
  for (const row of rows) {
    if (row.status_filter === "success" && !succeeded) {
      // Success-only follow-up on a failed/killed run: cancel it (it will never
      // be satisfied) so it doesn't linger as pending forever.
      cancelSchedule(row.id, { reason: "watched run did not succeed", cascade: true });
      continue;
    }
    fireSchedule(row.id, { late: false, completed: payload });
  }
}

/**
 * Fire one schedule by id. Idempotent via the `status='pending'` guard in the
 * UPDATE statements — a double-trigger (e.g. error+exit both emitted) is a
 * no-op the second time. Never throws.
 */
async function fireSchedule(id, ctx = {}) {
  const row = safeGet(id);
  if (!row || row.status !== "pending") return;

  const handler = dueCallbacks.get(row.target_kind);
  if (!handler) {
    markFailed(id, `no handler for target_kind "${row.target_kind}"`);
    return;
  }

  try {
    const { resultRunId } = (await handler(row, ctx)) || {};
    markFired(id, resultRunId || null, ctx.late ? 1 : 0);
    // Chaining: a schedule whose target is 'new_run' can itself be the trigger
    // of another pending schedule. Those wait on the run-status hook, so once
    // resultRunId exists the completion path picks them up automatically. We
    // only need to stamp chain_depth is already captured at create time.
  } catch (err) {
    markFailed(id, err?.message || String(err));
  }
}

/** target_kind 'new_run' handler — spawn through the normal run path. */
async function fireNewRun(row, ctx) {
  let opts = {};
  try {
    opts = JSON.parse(row.target_opts || "{}");
  } catch {
    opts = {};
  }
  const prompt = interpolate(row.prompt, ctx);
  const handle = deps.runs.spawnRun({
    prompt,
    mode: opts.mode === "headless" ? "headless" : "conversation",
    cwd: opts.cwd || undefined,
    model: opts.model || undefined,
    permissionMode: opts.permissionMode || undefined,
    permissionUx: opts.permissionUx === "interactive" ? "interactive" : undefined,
    effort: opts.effort || undefined,
  });
  return { resultRunId: handle.id };
}

/** target_kind 'session_message' handler — deliver a follow-up into a live run. */
async function fireSessionMessage(row, ctx) {
  let opts = {};
  try {
    opts = JSON.parse(row.target_opts || "{}");
  } catch {
    opts = {};
  }
  const runId = opts.runId;
  if (!runId) throw new Error("session_message target missing runId");
  const text = interpolate(row.prompt, ctx);
  deps.runs.sendInput(runId, text);
  return { resultRunId: runId };
}

/** Interpolate {status}/{exitCode}/{runId} from the completed run into the
 *  prompt template for on_run_complete follow-ups ("Part 3 finished: {status}.
 *  Now implement part 4 …"). Unknown tokens are left untouched. */
function interpolate(template, ctx) {
  if (typeof template !== "string") return template;
  const c = ctx && ctx.completed;
  if (!c) return template;
  return template
    .replace(/\{status\}/g, c.status ?? "")
    .replace(/\{exitCode\}/g, c.exitCode == null ? "" : String(c.exitCode))
    .replace(/\{runId\}/g, c.id ?? "");
}

function markFired(id, resultRunId, late) {
  try {
    deps.stmts.updateScheduleFired.run(resultRunId, late, id);
  } catch {
    /* ignore */
  }
  const row = safeGet(id);
  broadcast("schedule_fired", row);
  notify("Scheduled prompt fired", row && row.label ? row.label : "A scheduled prompt just fired");
}

function markFailed(id, error) {
  try {
    deps.stmts.updateScheduleFailed.run(error, id);
  } catch {
    /* ignore */
  }
  const row = safeGet(id);
  broadcast("schedule_failed", row);
  notify("Scheduled prompt failed", error || "A scheduled prompt failed to fire");
}

function broadcast(type, data) {
  if (deps && typeof deps.broadcast === "function" && data) {
    try {
      deps.broadcast(type, data);
    } catch {
      /* best-effort */
    }
  }
}

function notify(title, body) {
  if (!deps || !deps.push || !deps.db) return;
  try {
    deps.push
      .sendPushToAll(deps.db, title, body, "/scheduled", "scheduled_prompts")
      .catch(() => {});
  } catch {
    /* best-effort */
  }
}

function safeGet(id) {
  try {
    return deps.stmts.getSchedule.get(id) || null;
  } catch {
    return null;
  }
}

// ── Public API used by routes/schedules.js ──────────────────────────────────

/**
 * Create a schedule. Validates trigger/target shapes, persists it, and arms it
 * (for 'at') or leaves it to the run-status hook (for 'on_run_complete').
 * Returns the created row. Throws Error with a `.code` for the route to map.
 */
function createSchedule(input) {
  const {
    label = null,
    prompt,
    targetKind = "new_run",
    targetOpts = {},
    triggerKind = "at",
    fireAt = null,
    triggerRunId = null,
    statusFilter = "any",
    chainDepth = 0,
  } = input || {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw makeErr("EBADPROMPT", "prompt is required");
  }
  if (targetKind !== "new_run" && targetKind !== "session_message") {
    throw makeErr("EBADTARGET", 'targetKind must be "new_run" or "session_message"');
  }
  if (triggerKind !== "at" && triggerKind !== "on_run_complete") {
    throw makeErr("EBADTRIGGER", 'triggerKind must be "at" or "on_run_complete"');
  }
  if (triggerKind === "at") {
    const ms = fireAt ? Date.parse(fireAt) : NaN;
    if (!Number.isFinite(ms)) throw makeErr("EBADFIREAT", "fireAt must be a valid ISO timestamp");
  }
  if (triggerKind === "on_run_complete" && !triggerRunId) {
    throw makeErr("EBADRUNID", "triggerRunId is required for on_run_complete");
  }
  if (targetKind === "session_message" && !(targetOpts && targetOpts.runId)) {
    throw makeErr("EBADRUNID", "session_message target requires targetOpts.runId");
  }
  if (statusFilter !== "any" && statusFilter !== "success") {
    throw makeErr("EBADFILTER", 'statusFilter must be "any" or "success"');
  }
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    throw makeErr("ECHAINDEPTH", `chain depth limit ${MAX_CHAIN_DEPTH} reached`);
  }

  const id = randomUUID();
  try {
    deps.stmts.insertSchedule.run({
      id,
      label,
      prompt,
      target_kind: targetKind,
      target_opts: JSON.stringify(targetOpts || {}),
      trigger_kind: triggerKind,
      fire_at: triggerKind === "at" ? new Date(Date.parse(fireAt)).toISOString() : null,
      trigger_run_id: triggerKind === "on_run_complete" ? triggerRunId : null,
      status_filter: statusFilter,
      chain_depth: chainDepth,
    });
  } catch (err) {
    throw makeErr("EPERSIST", err.message);
  }

  const row = safeGet(id);
  if (triggerKind === "at") armAtTimer(row);
  broadcast("schedule_created", row);
  return row;
}

/** List schedules (optionally filtered by status). */
function listSchedules({ status = null, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    if (status) return deps.stmts.listSchedulesByStatus.all(status, safeLimit, safeOffset);
    return deps.stmts.listSchedules.all(safeLimit, safeOffset);
  } catch {
    return [];
  }
}

function getSchedule(id) {
  return safeGet(id);
}

/**
 * Cancel a pending schedule. When `cascade` is set, also cancel any pending
 * schedules that were chained to fire on THIS schedule's result run (its
 * dependents), recursively — the cancel-cascade the plan calls for.
 * Returns the number of schedules cancelled (0 if not pending / not found).
 */
function cancelSchedule(id, { reason = null, cascade = false } = {}) {
  const row = safeGet(id);
  if (!row || row.status !== "pending") return 0;

  let cancelled = 0;
  try {
    const info = deps.stmts.updateScheduleCancelled.run(id);
    cancelled += info.changes || 0;
  } catch {
    return 0;
  }
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  broadcast("schedule_cancelled", { ...safeGet(id), reason });

  if (cascade) {
    // Dependents watch a run this schedule would have produced. Since an
    // uncancelled schedule hasn't fired, result_run_id is null — but a follow-up
    // may target the parent trigger_run_id chain. Best-effort: cancel any
    // pending on_run_complete schedule whose trigger_run_id equals this
    // schedule's own result_run_id (populated only once fired) — so for an
    // unfired parent there are typically none. This keeps the cascade correct
    // for already-fired parents being cancelled by id.
    if (row.result_run_id) {
      let deps_rows = [];
      try {
        deps_rows = deps.stmts.listPendingSchedulesForRun.all(row.result_run_id);
      } catch {
        deps_rows = [];
      }
      for (const dep of deps_rows) {
        cancelled += cancelSchedule(dep.id, { reason: "parent cancelled", cascade: true });
      }
    }
  }
  return cancelled;
}

/** Edit a pending schedule's mutable fields (label/prompt/fireAt/statusFilter).
 *  Re-arms the 'at' timer when fireAt changes. Returns the updated row or null. */
function editSchedule(id, patch = {}) {
  const before = safeGet(id);
  if (!before || before.status !== "pending") return null;
  const fireAt =
    patch.fireAt != null && Number.isFinite(Date.parse(patch.fireAt))
      ? new Date(Date.parse(patch.fireAt)).toISOString()
      : null;
  try {
    deps.stmts.updateScheduleFields.run(
      patch.label ?? null,
      patch.prompt ?? null,
      fireAt,
      patch.statusFilter ?? null,
      id
    );
  } catch {
    return before;
  }
  const after = safeGet(id);
  if (fireAt && after && after.trigger_kind === "at") {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    armAtTimer(after);
  }
  broadcast("schedule_updated", after);
  return after;
}

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = {
  startScheduler,
  stopScheduler,
  registerDueCallback,
  createSchedule,
  listSchedules,
  getSchedule,
  cancelSchedule,
  editSchedule,
  MAX_CHAIN_DEPTH,
};
