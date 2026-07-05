/**
 * @file engine.js
 * @description Skill execution engine (Phase H, §H2). A skill is a straight
 * pipeline of steps (no branching, no loops - see store.js); this module runs
 * one step at a time, interpolating params and prior step outputs into each
 * step's template fields, logging progress to `skill_runs`, and broadcasting
 * `skill_run_*` WS events so the Skills page can show live progress.
 *
 * Safety model (never weaken, per CLAUDE.md): a skill's `confirm` level gates
 * who may trigger it -
 *   - `none`  - anyone/anything (manual tap, voice, phone, schedule).
 *   - `tap`   - a human tapping Run in the UI (no typed confirmation needed).
 *   - `typed` - a human must retype the skill's name to run it.
 * voice/phone/schedule triggers can ONLY ever fire a `confirm: none` skill -
 * this is enforced here, once, so no caller can accidentally bypass it.
 *
 * Step types: `shell` (arbitrary local command - this IS the feature, not a
 * bug: skills are the user's own personal automations, run on their own
 * machine), `agent` (spawn a Claude/Gemini run via run-spawner), `brain` (one
 * mini-Jarvis call), `notify` (a push), `phone` (a push whose tap deep-links
 * into the Skills page to hand off to iOS Shortcuts - see routes/skills.js
 * doc comment for why it isn't a direct `shortcuts://` link).
 */

const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { stmts, db } = require("../../db");
const store = require("./store");

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const VOICE_PHONE_SCHEDULE_TRIGGERS = new Set(["voice", "phone", "schedule"]);

let broadcastFn = null;
function setBroadcast(fn) {
  broadcastFn = typeof fn === "function" ? fn : null;
}
function emit(type, data) {
  if (broadcastFn) {
    try {
      broadcastFn(type, data);
    } catch {
      /* best-effort */
    }
  }
}

const cancelled = new Set(); // runId → requested-cancel flag
const activeShells = new Map(); // runId → child process (killed on cancel)

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function untildeCwd(p) {
  if (!p) return os.homedir();
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function truncate(s, n = MAX_OUTPUT_CHARS) {
  const str = String(s == null ? "" : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function interpolate(template, ctx) {
  if (typeof template !== "string") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key]) : m
  );
}

function stepLabel(step, index) {
  if (typeof step.label === "string" && step.label.trim()) return step.label.trim();
  switch (step.type) {
    case "shell":
      return `Shell: ${truncate(step.command || "", 60)}`;
    case "agent":
      return `Agent (${step.provider || "claude"}): ${truncate(step.prompt || "", 50)}`;
    case "brain":
      return `Brain (${step.taskClass || "standard"}): ${truncate(step.prompt || "", 50)}`;
    case "notify":
      return `Notify: ${truncate(step.message || "", 50)}`;
    case "phone":
      return `Phone: ${step.shortcut || step.name || "Shortcut"}`;
    default:
      return `Step ${index + 1}`;
  }
}

// ── Step handlers - each returns a short text summary used as its output and
// interpolated into later steps as {stepN_output} / {<type>_output}. ────────

function runShellStep(step, ctx, runId) {
  const command = interpolate(step.command || "", ctx);
  if (!command.trim()) throw makeErr("EBADSTEP", "shell step is missing a command");
  const cwd = untildeCwd(step.cwd ? interpolate(step.cwd, ctx) : undefined);
  const timeoutMs = Math.min(
    Number.isFinite(step.timeout) && step.timeout > 0
      ? step.timeout * 1000
      : DEFAULT_SHELL_TIMEOUT_MS,
    MAX_SHELL_TIMEOUT_MS
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        activeShells.delete(runId);
        if (err) {
          const killedByTimeout = err.killed && err.signal;
          reject(
            makeErr(
              "ESHELL",
              killedByTimeout
                ? `command timed out after ${Math.round(timeoutMs / 1000)}s`
                : truncate(stderr || err.message, 2000)
            )
          );
          return;
        }
        resolve(truncate(stdout).trim() || "(no output)");
      }
    );
    activeShells.set(runId, child);
  });
}

async function runAgentStep(step, ctx) {
  const runs = require("../run-spawner");
  const prompt = interpolate(step.prompt || "", ctx);
  if (!prompt.trim()) throw makeErr("EBADSTEP", "agent step is missing a prompt");
  let handle;
  try {
    handle = runs.spawnRun({
      prompt,
      mode: "headless",
      cwd: step.cwd ? untildeCwd(interpolate(step.cwd, ctx)) : undefined,
      provider: typeof step.provider === "string" ? step.provider : undefined,
      permissionUx: step.permissionUx === "interactive" ? "interactive" : undefined,
    });
  } catch (err) {
    throw makeErr("EAGENT", err.message);
  }
  if (step.wait !== true) {
    return `spawned run ${handle.id.slice(0, 8)} (not waited on - see Run page)`;
  }
  const timeoutMs =
    Number.isFinite(step.timeout) && step.timeout > 0
      ? step.timeout * 1000
      : DEFAULT_AGENT_WAIT_TIMEOUT_MS;
  const result = await waitForRunTerminal(runs, handle.id, timeoutMs);
  return `run ${handle.id.slice(0, 8)} ${result.status}${
    result.exitCode != null ? ` (exit ${result.exitCode})` : ""
  }`;
}

function waitForRunTerminal(runs, runId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve({ status: "timeout", exitCode: null });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    unsubscribe = runs.onRunStatus((payload) => {
      if (done || !payload || payload.id !== runId) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

async function runBrainStep(step, ctx) {
  const router = require("../brain/router");
  const prompt = interpolate(step.prompt || "", ctx);
  if (!prompt.trim()) throw makeErr("EBADSTEP", "brain step is missing a prompt");
  const taskClass = ["simple", "standard", "complex"].includes(step.taskClass)
    ? step.taskClass
    : "standard";
  try {
    const result = await router.complete({ prompt, taskClass, intent: "skill" });
    return truncate(result.text);
  } catch (err) {
    throw makeErr(
      "EBRAIN",
      err.code === "ENOPROVIDER" ? "no brain provider is configured" : err.message
    );
  }
}

async function runNotifyStep(step, ctx, skillName) {
  const message = interpolate(step.message || `"${skillName}" finished a step.`, ctx);
  const title = typeof step.title === "string" ? interpolate(step.title, ctx) : skillName;
  const category =
    typeof step.category === "string" && step.category.trim() ? step.category.trim() : "skills";
  // Phase O facade: push + inbox row + WS badge.
  require("../notify").notify({
    category,
    title,
    body: message,
    url: "/skills",
    data: { skill: skillName },
    source: "skills",
  });
  return message;
}

async function runPhoneStep(step, ctx, runId, skillName) {
  const shortcut = interpolate(step.shortcut || step.name || "", ctx);
  if (!shortcut.trim()) throw makeErr("EBADSTEP", "phone step is missing a shortcut name");
  const message = interpolate(
    step.message || `Tap to hand off to the "${shortcut}" Shortcut.`,
    ctx
  );
  // iOS gives no way to fire a Shortcut from a background push directly - the
  // tap opens the PWA deep-linked to this run; the Skills page then renders an
  // `<a href="shortcuts://…">` link (a real link tap is what iOS honors for a
  // custom URL scheme handoff, unlike a Service Worker `client.navigate()`).
  const url = `/skills?phoneRun=${encodeURIComponent(runId)}`;
  require("../notify").notify({
    category: "skills",
    title: `${skillName} — phone handoff`,
    body: message,
    url,
    data: { skill: skillName, runId, shortcut },
    source: "skills",
  });
  return JSON.stringify({ shortcut, message });
}

// ── Run orchestration ────────────────────────────────────────────────────

function safeGetRun(id) {
  try {
    return stmts.getSkillRun.get(id) || null;
  } catch {
    return null;
  }
}

function toApiRun(row) {
  if (!row) return null;
  let steps = [];
  let params = {};
  try {
    steps = JSON.parse(row.steps || "[]");
  } catch {
    steps = [];
  }
  try {
    params = JSON.parse(row.params || "{}");
  } catch {
    params = {};
  }
  return { ...row, steps, params };
}

function getRun(id) {
  return toApiRun(safeGetRun(id));
}

function listRuns({ skillId = null, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  try {
    if (skillId) return stmts.listSkillRunsBySkill.all(skillId, safeLimit).map(toApiRun);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    return stmts.listSkillRuns.all(safeLimit, safeOffset).map(toApiRun);
  } catch {
    return [];
  }
}

function persistSteps(runId, steps) {
  try {
    stmts.updateSkillRunSteps.run(JSON.stringify(steps), runId);
  } catch {
    /* best-effort - the in-memory run still finishes correctly */
  }
}

function finishRun(runId, status, error, steps) {
  try {
    stmts.finishSkillRun.run(status, error || null, JSON.stringify(steps), runId);
  } catch {
    /* ignore */
  }
  cancelled.delete(runId);
  activeShells.delete(runId);
  emit(status === "success" ? "skill_run_finished" : "skill_run_failed", getRun(runId));
}

async function executeSteps(runId, def, params, steps) {
  const ctx = { ...params };
  for (let i = 0; i < steps.length; i++) {
    if (cancelled.has(runId)) {
      steps[i].status = "cancelled";
      finishRun(runId, "cancelled", "cancelled by user", steps);
      return;
    }
    const step = def.steps[i];
    steps[i].status = "running";
    steps[i].startedAt = new Date().toISOString();
    persistSteps(runId, steps);
    emit("skill_run_step", getRun(runId));

    try {
      let output;
      switch (step.type) {
        case "shell":
          output = await runShellStep(step, ctx, runId);
          break;
        case "agent":
          output = await runAgentStep(step, ctx);
          break;
        case "brain":
          output = await runBrainStep(step, ctx);
          break;
        case "notify":
          output = await runNotifyStep(step, ctx, def.name);
          break;
        case "phone":
          output = await runPhoneStep(step, ctx, runId, def.name);
          break;
        default:
          throw makeErr("EBADSTEP", `unknown step type "${step.type}"`);
      }
      steps[i].status = "success";
      steps[i].output = output == null ? null : truncate(output);
      steps[i].finishedAt = new Date().toISOString();
      ctx[`step${i + 1}_output`] = steps[i].output;
      ctx[`${step.type}_output`] = steps[i].output;
      persistSteps(runId, steps);
      emit("skill_run_step", getRun(runId));
    } catch (err) {
      steps[i].status = "failed";
      steps[i].error = err?.message || String(err);
      steps[i].finishedAt = new Date().toISOString();
      finishRun(runId, "failed", steps[i].error, steps);
      return;
    }
  }
  finishRun(runId, "success", null, steps);
}

/**
 * Kick off a skill run. Returns the created run row immediately; execution
 * happens in the background (poll GET /api/skills/runs/:id or listen for
 * `skill_run_*` WS events for progress).
 */
function runSkill({ skillId, params = {}, trigger = "manual", confirmText = null } = {}) {
  const def = store.getSkill(skillId);
  if (!def) throw makeErr("ENOTFOUND", "skill not found");
  if (!def.valid)
    throw makeErr("EBADSKILL", `skill definition is invalid: ${def.errors.join("; ")}`);

  if (VOICE_PHONE_SCHEDULE_TRIGGERS.has(trigger) && def.confirm !== "none") {
    throw makeErr(
      "ECONFIRM",
      `"${def.name}" requires a ${def.confirm} confirmation and cannot be triggered by ${trigger}`
    );
  }
  if (def.confirm === "typed") {
    const name = def.name.trim().toLowerCase();
    if (typeof confirmText !== "string" || confirmText.trim().toLowerCase() !== name) {
      throw makeErr("ECONFIRM", "typed confirmation does not match the skill name");
    }
  }

  const runId = randomUUID();
  const steps = def.steps.map((s, i) => ({
    index: i,
    type: s.type,
    label: stepLabel(s, i),
    status: "pending",
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }));

  try {
    stmts.insertSkillRun.run({
      id: runId,
      skill_id: def.id,
      skill_name: def.name,
      trigger,
      params: JSON.stringify(params || {}),
      steps: JSON.stringify(steps),
    });
  } catch (err) {
    throw makeErr("EPERSIST", err.message);
  }

  const row = getRun(runId);
  emit("skill_run_started", row);
  executeSteps(runId, def, params || {}, steps).catch((err) => {
    console.warn(`[skills] run ${runId} crashed:`, err?.message || err);
    finishRun(runId, "failed", err?.message || String(err), steps);
  });

  return row;
}

/** Request cancellation of a running skill. Takes effect before the next step
 *  (and kills an in-flight shell step immediately). Returns false if the run
 *  isn't currently running. */
function cancelRun(runId) {
  const row = safeGetRun(runId);
  if (!row || row.status !== "running") return false;
  cancelled.add(runId);
  const child = activeShells.get(runId);
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Flip any skill_runs the previous process left `running` to `failed` - those
 *  in-process steps died with the server; there's no way to resume them. */
function reconcileOrphanRuns() {
  let rows = [];
  try {
    rows = stmts.listRunningSkillRuns.all();
  } catch {
    return 0;
  }
  for (const row of rows) {
    let steps = [];
    try {
      steps = JSON.parse(row.steps || "[]");
    } catch {
      steps = [];
    }
    for (const s of steps) {
      if (s.status === "running" || s.status === "pending") s.status = "cancelled";
    }
    try {
      stmts.finishSkillRun.run("failed", "server restarted mid-run", JSON.stringify(steps), row.id);
    } catch {
      /* ignore */
    }
  }
  return rows.length;
}

module.exports = {
  setBroadcast,
  runSkill,
  cancelRun,
  getRun,
  listRuns,
  reconcileOrphanRuns,
};
