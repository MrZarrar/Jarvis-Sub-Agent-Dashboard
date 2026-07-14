/**
 * @file scheduler.js
 * @description Persistent scheduler for deferred & chained prompts (Phase L).
 * Two trigger kinds:
 *   - 'at'               - fire at a wall-clock timestamp (setTimeout-armed).
 *   - 'on_run_complete'  - fire when a watched run reaches a terminal status,
 *                          driven by run-spawner's onRunStatus hook (no polling).
 * Three target kinds:
 *   - 'new_run'          - spawn a fresh claude run with the opts captured at
 *                          schedule time (goes through the normal spawn path so
 *                          permission gating, envelopes, and WS broadcasts all
 *                          apply - nothing bespoke).
 *   - 'session_message'  - deliver the prompt into a live run via run-spawner's
 *                          sendInput (the same path /api/run/:id/message uses).
 *   - 'mission'          - create or continue a provider-neutral mission.
 *
 * Design goals (repo rules): survive restarts (pending schedules re-arm from
 * SQLite on boot; a missed 'at' time fires immediately with a `late` flag), and
 * be strictly fail-safe - a scheduler crash must never take down the server or
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
const recurringTimers = new Map(); // name → { interval, initial } (for G2 pulse / H5 cron)

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
  registerDueCallback("mission", fireMission);

  // Completion triggers - driven, not polled.
  if (runs && typeof runs.onRunStatus === "function") {
    unsubscribeRunStatus = runs.onRunStatus(onRunTerminal);
  }

  reArmPending();
  registerRecurringTask({
    name: "mission-timeouts",
    intervalMs: 30_000,
    initialDelayMs: 30_000,
    fn: enforceMissionTimeouts,
  });
}

/**
 * Register a fail-safe recurring internal task. This is the shared scheduler's
 * home for periodic jobs so later phases don't spin up their own timers: G2's
 * daily project-pulse recompute uses it, and H5 (skill cron) will too. The task
 * fn is always wrapped so a throw is logged-and-swallowed - a bad task can never
 * take the server down. Timers are unref'd so they never block shutdown.
 *
 * @param {object} args
 * @param {string} args.name           Unique name (re-registering replaces).
 * @param {number} args.intervalMs      How often to run.
 * @param {number} [args.initialDelayMs] Delay before the first run (default: 1 interval).
 * @param {Function} args.fn            The task (sync or async).
 */
function registerRecurringTask({ name, intervalMs, initialDelayMs, fn } = {}) {
  if (!name || typeof fn !== "function" || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
  clearRecurring(name);
  const safeRun = async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[scheduler] recurring task "${name}" failed:`, err?.message || err);
    }
  };
  const initialMs = Number.isFinite(initialDelayMs) ? Math.max(0, initialDelayMs) : intervalMs;
  const initial = setTimeout(safeRun, initialMs);
  if (initial.unref) initial.unref();
  const interval = setInterval(safeRun, intervalMs);
  if (interval.unref) interval.unref();
  recurringTimers.set(name, { interval, initial });
}

function clearRecurring(name) {
  const entry = recurringTimers.get(name);
  if (!entry) return;
  clearTimeout(entry.initial);
  clearInterval(entry.interval);
  recurringTimers.delete(name);
}

function stopScheduler() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const name of [...recurringTimers.keys()]) clearRecurring(name);
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
 *  immediately with `late`. 'on_run_complete' schedules need no arming - they
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
    if (late && row.missed_run_policy === "skip") {
      skipMissed(row);
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
 * UPDATE statements - a double-trigger (e.g. error+exit both emitted) is a
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
    const { resultRunId, deferred } = (await handler(row, ctx)) || {};
    if (deferred) return;
    if (row.recurrence) markRecurring(row, resultRunId || null, ctx.late ? 1 : 0);
    else markFired(id, resultRunId || null, ctx.late ? 1 : 0);
    // Chaining: a schedule whose target is 'new_run' can itself be the trigger
    // of another pending schedule. Those wait on the run-status hook, so once
    // resultRunId exists the completion path picks them up automatically. We
    // only need to stamp chain_depth is already captured at create time.
  } catch (err) {
    if (row.target_kind === "mission" && Number(row.retry_attempts) < Number(row.retry_limit)) {
      retryLater(row, err?.message || String(err));
    } else {
      markFailed(id, err?.message || String(err));
    }
  }
}

function retryLater(row, error) {
  const next = new Date(Date.now() + 60_000).toISOString();
  deps.db
    .prepare(
      `UPDATE scheduled_prompts SET trigger_kind = 'at', fire_at = ?, retry_attempts = retry_attempts + 1,
       error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending'`
    )
    .run(next, error, row.id);
  const fresh = safeGet(row.id);
  broadcast("schedule_updated", fresh);
  armAtTimer(fresh);
}

function skipMissed(row) {
  if (!row.recurrence) {
    cancelSchedule(row.id, { reason: "missed run skipped" });
    return;
  }
  const next = nextOccurrence(row.recurrence, row.fire_at);
  deps.db
    .prepare(
      `UPDATE scheduled_prompts SET fire_at = ?, late = 1, error = 'missed run skipped',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'`
    )
    .run(next, row.id);
  const fresh = safeGet(row.id);
  broadcast("schedule_updated", fresh);
  armAtTimer(fresh);
}

async function enforceMissionTimeouts() {
  const rows = deps.db
    .prepare(
      `SELECT s.id AS schedule_id, s.timeout_seconds, m.id AS mission_id, m.started_at
       FROM scheduled_prompts s JOIN missions m ON m.id = s.current_mission_id
       WHERE m.status IN ('queued','planning','delegated','running','waiting_approval')`
    )
    .all();
  const missions = require("./missions");
  for (const row of rows) {
    const deadline =
      Date.parse(row.started_at) + Math.max(60, Number(row.timeout_seconds) || 1800) * 1000;
    if (Date.now() <= deadline) continue;
    await missions.interruptMission(row.mission_id);
    deps.db
      .prepare(
        `UPDATE scheduled_prompts SET error = 'mission timed out',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      )
      .run(row.schedule_id);
  }
}

/** target_kind 'mission' handler - all domains use the same mission policy. */
async function fireMission(row) {
  if (!require("./features").enabled("codex_schedules")) {
    throw new Error("Codex mission schedules are disabled by JARVIS_FEATURE_CODEX_SCHEDULES");
  }
  const missions = require("./missions");
  let opts = {};
  try {
    opts = JSON.parse(row.target_opts || "{}");
  } catch {
    opts = {};
  }
  const current = row.current_mission_id ? missions.getMission(row.current_mission_id) : null;
  if (current && missions.ACTIVE.has(current.status)) {
    if (row.thread_strategy === "steer_active") {
      await missions.steerMission(current.id, row.prompt);
      return { resultRunId: current.id };
    }
    if (row.overlap_policy === "skip") return { resultRunId: current.id };
    if (row.overlap_policy === "queue") {
      const next = new Date(Date.now() + 60_000).toISOString();
      deps.db
        .prepare(
          "UPDATE scheduled_prompts SET fire_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
        )
        .run(next, row.id);
      armAtTimer(safeGet(row.id));
      return { deferred: true };
    }
    if (row.overlap_policy === "cancel_previous") await missions.interruptMission(current.id);
  }
  const mission = await missions.createMission({
    prompt: row.prompt,
    title: row.label || undefined,
    domain: row.domain || "personal",
    interaction: "scheduled_mission",
    requestedProvider: row.owner_provider || undefined,
    modelTier: row.model_tier || undefined,
    workspace: row.workspace || opts.cwd || undefined,
    agentRole: row.agent_role || undefined,
    approvalPolicy: row.approval_policy || "never",
    sandboxPolicy: row.sandbox_policy || "read-only",
    nativeThreadId:
      row.thread_strategy === "resume_thread" ? row.native_thread_id || undefined : undefined,
    origin: "schedule",
    scheduleId: row.id,
  });
  deps.db
    .prepare(
      "UPDATE scheduled_prompts SET current_mission_id = ?, last_mission_id = ?, native_thread_id = COALESCE(?, native_thread_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
    .run(mission.id, mission.id, mission.native_thread_id || null, row.id);
  return { resultRunId: mission.id };
}

function nextOccurrence(recurrence, after) {
  const parts = Object.fromEntries(
    String(recurrence || "")
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((part) => part.split("=", 2).map((value) => value.trim().toUpperCase()))
      .filter((part) => part.length === 2)
  );
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const unit = { MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: 86_400_000, WEEKLY: 604_800_000 }[
    parts.FREQ
  ];
  if (!unit) throw new Error("recurrence supports MINUTELY, HOURLY, DAILY, or WEEKLY");
  let next = Date.parse(after) + unit * interval;
  while (next <= Date.now()) next += unit * interval;
  return new Date(next).toISOString();
}

function markRecurring(row, resultId, late) {
  try {
    const next = nextOccurrence(row.recurrence, row.fire_at);
    deps.db
      .prepare(
        "UPDATE scheduled_prompts SET fire_at = ?, result_run_id = ?, last_mission_id = COALESCE(?, last_mission_id), late = ?, fired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
      )
      .run(next, resultId, resultId, late, row.id);
    const fresh = safeGet(row.id);
    broadcast("schedule_fired", fresh);
    armAtTimer(fresh);
    notify(
      "Scheduled mission started",
      `${row.label || "Schedule"} ran; next ${next}.`,
      row.id,
      resultId
    );
  } catch (error) {
    markFailed(row.id, error?.message || String(error));
  }
}

/** target_kind 'new_run' handler - spawn through the normal run path. */
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

/** target_kind 'session_message' handler - deliver a follow-up into a live run. */
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
  const label = row && row.label ? `"${row.label}"` : `schedule ${String(id).slice(0, 8)}`;
  notify(
    "Scheduled prompt fired",
    `${label} fired${late ? " (late)" : ""}${resultRunId ? " — run spawned, tap to follow" : ""}.`,
    id,
    resultRunId
  );
}

function markFailed(id, error) {
  try {
    deps.stmts.updateScheduleFailed.run(error, id);
  } catch {
    /* ignore */
  }
  const row = safeGet(id);
  broadcast("schedule_failed", row);
  const label = row && row.label ? `"${row.label}"` : `schedule ${String(id).slice(0, 8)}`;
  notify("Scheduled prompt failed", `${label} failed: ${error || "unknown error"}`, id);
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

function notify(title, body, scheduleId, resultRunId) {
  if (!deps || !deps.push || !deps.db) return;
  try {
    const schedule = scheduleId ? safeGet(scheduleId) : null;
    const isMission = schedule?.target_kind === "mission";
    // Phase O facade: push + inbox row + WS, exact copy composed by callers.
    require("./notify").notify({
      category: "scheduled_prompts",
      title,
      body,
      url: resultRunId
        ? isMission
          ? `/missions/${encodeURIComponent(resultRunId)}`
          : `/run?runId=${encodeURIComponent(resultRunId)}`
        : "/scheduled",
      data: {
        scheduleId: scheduleId || null,
        runId: isMission ? null : resultRunId || null,
        missionId: isMission ? resultRunId || null : null,
      },
      source: "scheduler",
      dedupeKey: scheduleId ? `schedule:${scheduleId}` : undefined,
      escalate: true,
    });
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
    recurrence = null,
    domain = "personal",
    ownerProvider = null,
    modelTier = null,
    workspace = null,
    agentRole = null,
    approvalPolicy = "never",
    sandboxPolicy = "read-only",
    threadStrategy = "new_thread",
    notificationPolicy = "all",
    overlapPolicy = "skip",
    missedRunPolicy = "run_once",
    retryLimit = 0,
    timeoutSeconds = 1800,
  } = input || {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw makeErr("EBADPROMPT", "prompt is required");
  }
  if (!["new_run", "session_message", "mission"].includes(targetKind)) {
    throw makeErr("EBADTARGET", 'targetKind must be "new_run", "session_message", or "mission"');
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
  if (recurrence) nextOccurrence(recurrence, fireAt);
  if (!["new_thread", "resume_thread", "steer_active"].includes(threadStrategy)) {
    throw makeErr("EBADTHREAD", "invalid threadStrategy");
  }
  if (!["skip", "queue", "cancel_previous"].includes(overlapPolicy)) {
    throw makeErr("EBADOVERLAP", "invalid overlapPolicy");
  }
  if (!["run_once", "skip", "catch_up"].includes(missedRunPolicy)) {
    throw makeErr("EBADMISSED", "invalid missedRunPolicy");
  }
  if (targetKind === "mission") {
    if (!["read-only", "workspace-write"].includes(sandboxPolicy)) {
      throw makeErr(
        "EBADSANDBOX",
        "scheduled missions support read-only or explicit workspace-write only"
      );
    }
    if (sandboxPolicy === "workspace-write" && !workspace && !targetOpts?.cwd) {
      throw makeErr("EBADWORKSPACE", "workspace-write schedules require an explicit workspace");
    }
    if (!["never", "on-request"].includes(approvalPolicy)) {
      throw makeErr("EBADAPPROVAL", "invalid scheduled approval policy");
    }
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
    deps.db
      .prepare(
        `UPDATE scheduled_prompts SET
          recurrence = ?, domain = ?, owner_provider = ?, model_tier = ?, workspace = ?,
          agent_role = ?, approval_policy = ?, sandbox_policy = ?, thread_strategy = ?,
          notification_policy = ?, overlap_policy = ?, missed_run_policy = ?, retry_limit = ?,
          timeout_seconds = ? WHERE id = ?`
      )
      .run(
        recurrence || null,
        domain,
        ownerProvider || null,
        modelTier || null,
        workspace || null,
        agentRole || null,
        approvalPolicy,
        sandboxPolicy,
        threadStrategy,
        notificationPolicy,
        overlapPolicy,
        missedRunPolicy,
        Math.min(5, Math.max(0, Number(retryLimit) || 0)),
        Math.min(86_400, Math.max(60, Number(timeoutSeconds) || 1800)),
        id
      );
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
 * dependents), recursively - the cancel-cascade the plan calls for.
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
    // uncancelled schedule hasn't fired, result_run_id is null - but a follow-up
    // may target the parent trigger_run_id chain. Best-effort: cancel any
    // pending on_run_complete schedule whose trigger_run_id equals this
    // schedule's own result_run_id (populated only once fired) - so for an
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
  registerRecurringTask,
  createSchedule,
  listSchedules,
  getSchedule,
  cancelSchedule,
  editSchedule,
  MAX_CHAIN_DEPTH,
  nextOccurrence,
};
