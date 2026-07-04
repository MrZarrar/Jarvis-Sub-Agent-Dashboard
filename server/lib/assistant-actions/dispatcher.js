/**
 * @file assistant-actions/dispatcher.js
 * @description THE single enforcement point for assistant agency (Phase M, §3.1
 * + repo rule §6: "Agency safety is one dispatcher"). Every action - typed into
 * the popup, spoken to Siri, fired by a schedule, or called by an LLM's tool-use
 * - flows through `dispatch()`. No producer may call an action's `execute`
 * directly. Mirrors the skills confirm model (server/lib/skills/engine.js):
 *
 *   risk "safe"    - any source may run it.
 *   risk "confirm" - only an interactive popup ("chat"), and only after a tap:
 *                    the first call returns a confirmToken; the caller re-sends
 *                    it (a real human tap on a rendered chip) to execute.
 *   risk "typed"   - only "chat", and only when the user retypes the action name.
 *
 * Non-interactive sources (siri/carplay/voice/phone/schedule/auto) may ONLY ever
 * run `safe` actions - never confirm/typed - exactly like voice-triggered skills.
 *
 * Outcomes: "done" | "needs_confirm" | "denied" | "error". Client-side actions
 * (side:"client") are validated, gated, and logged here but NOT executed - a
 * "done" client action is returned in the ask response for the browser to run.
 *
 * @author Jarvis (Phase M1)
 */

const crypto = require("node:crypto");
const registry = require("./registry");

// Sources that can never run anything above `safe`. Kept in sync with the
// skills engine's VOICE_PHONE_SCHEDULE_TRIGGERS intent.
const NON_INTERACTIVE = new Set([
  "siri",
  "carplay",
  "voice",
  "phone",
  "schedule",
  "auto",
  "quickaction",
]);
const CONFIRM_TOKEN_TTL_MS = 5 * 60_000;

// runId of pending confirm tokens → { name, paramsHash, source, expiresAt }.
const pendingConfirms = new Map();

function paramsHash(params) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(params || {}))
    .digest("hex");
}

function pruneTokens(now) {
  for (const [token, rec] of pendingConfirms) {
    if (now >= rec.expiresAt) pendingConfirms.delete(token);
  }
}

function mintConfirmToken(name, hash, source) {
  const now = Date.now();
  pruneTokens(now);
  const token = crypto.randomUUID();
  pendingConfirms.set(token, {
    name,
    paramsHash: hash,
    source,
    expiresAt: now + CONFIRM_TOKEN_TTL_MS,
  });
  return token;
}

function consumeConfirmToken(token, name, hash) {
  const rec = pendingConfirms.get(token);
  if (!rec) return false;
  const ok = rec.name === name && rec.paramsHash === hash && Date.now() < rec.expiresAt;
  if (ok) pendingConfirms.delete(token);
  return ok;
}

/** Validate params against the action's JSON-schema-ish `required` list. */
function validate(action, params) {
  const required = (action.params && action.params.required) || [];
  for (const key of required) {
    const v = params ? params[key] : undefined;
    if (v == null || (typeof v === "string" && !v.trim())) {
      return `missing required param "${key}"`;
    }
  }
  return null;
}

function logAction({ action, params, source, risk, outcome, error }) {
  try {
    const { stmts } = require("../../db");
    stmts.insertAssistantAction.run({
      id: crypto.randomUUID(),
      action: action || null,
      params_hash: params ? paramsHash(params) : null,
      source: source || null,
      risk: risk || null,
      outcome,
      error: error || null,
    });
  } catch {
    /* logging is auditability, never a blocker */
  }
}

/**
 * Run one action through the gate.
 * @param {object} args
 * @param {string} args.name            Action name.
 * @param {object} [args.params]        Action params.
 * @param {string} [args.source]        Who is asking (chat|siri|schedule|…).
 * @param {object} [args.ctx]           Extra context passed to execute (source injected).
 * @param {string} [args.confirmToken]  Token from a prior needs_confirm (for `confirm` risk).
 * @param {string} [args.typedConfirm]  Retyped action name (for `typed` risk).
 * @returns {Promise<{status,name,risk,side,result?,confirmToken?,error?,reason?}>}
 */
async function dispatch({
  name,
  params = {},
  source = "chat",
  ctx = {},
  confirmToken,
  typedConfirm,
} = {}) {
  const action = registry.get(name);
  if (!action) {
    logAction({
      action: name,
      params,
      source,
      risk: null,
      outcome: "error",
      error: "unknown action",
    });
    return { status: "error", name, error: `unknown action "${name}"` };
  }
  const base = { name: action.name, risk: action.risk, side: action.side };

  const invalid = validate(action, params);
  if (invalid) {
    logAction({
      action: name,
      params,
      source,
      risk: action.risk,
      outcome: "error",
      error: invalid,
    });
    return { status: "error", ...base, error: invalid };
  }

  // ── Risk gate (the one place) ──────────────────────────────────────────────
  if (action.risk !== "safe") {
    if (NON_INTERACTIVE.has(source)) {
      logAction({
        action: name,
        params,
        source,
        risk: action.risk,
        outcome: "denied",
        error: `${source} cannot run ${action.risk}`,
      });
      return {
        status: "denied",
        ...base,
        reason: `"${action.name}" needs a ${action.risk} confirmation and cannot be triggered by ${source}.`,
      };
    }
    const hash = paramsHash(params);
    if (action.risk === "confirm") {
      if (!confirmToken || !consumeConfirmToken(confirmToken, action.name, hash)) {
        const token = mintConfirmToken(action.name, hash, source);
        logAction({ action: name, params, source, risk: action.risk, outcome: "needs_confirm" });
        return { status: "needs_confirm", ...base, confirmToken: token };
      }
    } else if (action.risk === "typed") {
      const typed = typeof typedConfirm === "string" ? typedConfirm.trim().toLowerCase() : "";
      if (typed !== action.name.toLowerCase()) {
        logAction({ action: name, params, source, risk: action.risk, outcome: "needs_confirm" });
        return { status: "needs_confirm", ...base, requiresTyped: true };
      }
    }
  }

  // ── Client-side action: validated+gated+logged here, executed by the browser.
  if (action.side === "client") {
    logAction({ action: name, params, source, risk: action.risk, outcome: "done" });
    return { status: "done", ...base, params };
  }

  // ── Server-side action: execute in-process.
  try {
    const result = await action.execute(params || {}, { ...ctx, source });
    logAction({ action: name, params, source, risk: action.risk, outcome: "done" });
    return { status: "done", ...base, result: result == null ? {} : result };
  } catch (err) {
    logAction({
      action: name,
      params,
      source,
      risk: action.risk,
      outcome: "error",
      error: err?.message || String(err),
    });
    return { status: "error", ...base, error: err?.message || String(err) };
  }
}

module.exports = { dispatch, paramsHash, __pendingConfirms: pendingConfirms };
