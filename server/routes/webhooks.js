/**
 * @file Express router for universal webhook targets across 14 providers
 * (Slack, Discord, Teams, Google Chat, Mattermost, Rocket.Chat, Telegram,
 * PagerDuty, Opsgenie, Splunk On-Call, Zapier, Make, n8n, Pipedream, generic).
 * Provides target CRUD, a synchronous "send test" probe, a per-target delivery
 * log, and redacted provider metadata for the UI. Secrets are never returned -
 * URLs are masked and secret config / header values are redacted in every
 * response. Delivery + provider definitions live in server/lib/.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const { stmts } = require("../db");
const { invalidateWebhookCache, normalizeTarget, sendTest } = require("../lib/webhooks");
const {
  PROVIDERS,
  WEBHOOK_TYPES,
  isGenericFamily,
  resolveUrl,
  urlRequired,
  publicProviders,
} = require("../lib/webhook-providers");

const router = Router();

// ── Serialization (redacted) ──────────────────────────────────────────────

// Reveal the host + last 4 chars so a user can recognize which webhook this is
// without exposing any embedded secret token.
function maskUrl(url) {
  if (!url) return "…";
  try {
    const u = new URL(url);
    const tail = url.length > 4 ? url.slice(-4) : "";
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    return "…";
  }
}

// Custom header values can carry auth tokens - return only the keys, masked.
function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const keys = Object.keys(headers);
  if (keys.length === 0) return null;
  const out = {};
  for (const k of keys) out[k] = "••••";
  return out;
}

// Mask provider config fields flagged secret (routing keys, api keys, tokens);
// show the rest (chat_id, region, severity, …).
function redactConfig(type, config) {
  if (!config || typeof config !== "object") return null;
  const fields = PROVIDERS[type]?.fields || [];
  const secretKeys = new Set(fields.filter((f) => f.secret).map((f) => f.key));
  const out = {};
  for (const [k, v] of Object.entries(config)) out[k] = secretKeys.has(k) ? "••••" : v;
  return Object.keys(out).length ? out : null;
}

function serializeTarget(row) {
  const t = normalizeTarget(row);
  let last = null;
  try {
    last = stmts.lastWebhookDeliveryForTarget.get(t.id) || null;
  } catch {
    /* delivery log read is best-effort */
  }
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    enabled: t.enabled,
    url_preview: maskUrl(resolveUrl(t)),
    has_secret: !!t.secret,
    headers: isGenericFamily(t.type) ? redactHeaders(t.headers) : null,
    config: redactConfig(t.type, t.config),
    rule_ids: t.rule_ids && t.rule_ids.length ? t.rule_ids : null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_delivery: last
      ? {
          status: last.status,
          status_code: last.status_code,
          attempts: last.attempts,
          error: last.error,
          created_at: last.created_at,
        }
      : null,
  };
}

// ── Validation ────────────────────────────────────────────────────────────

function bad(res, message) {
  return res.status(400).json({ error: { code: "INVALID_INPUT", message } });
}

function validateUrl(url, type) {
  if (typeof url !== "string" || !url.trim()) return { ok: false, error: "url is required" };
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, error: "url must be a valid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "url must use http or https" };
  }
  // Most providers' endpoints are https-only; only the generic family with
  // https:false (generic, n8n) permits http (for local/self-hosted testing).
  const allowHttp = PROVIDERS[type]?.https === false;
  if (!allowHttp && u.protocol !== "https:") {
    return { ok: false, error: `${type} webhook URL must use https` };
  }
  return { ok: true, url: url.trim() };
}

// Validate (and normalize) provider config, merging supplied values over a base
// (the existing config on PATCH) so a single field can change without re-sending
// secrets. Returns { ok, value } where value is the full config object or null.
function validateConfig(type, input, base = {}) {
  const fields = PROVIDERS[type]?.fields || [];
  if (input != null && (typeof input !== "object" || Array.isArray(input))) {
    return { ok: false, error: "config must be an object" };
  }
  const supplied = input || {};
  const out = {};
  for (const f of fields) {
    // Effective value: a non-empty supplied value wins, else fall back to base.
    let v = supplied[f.key];
    if (v == null || v === "") v = base[f.key];

    if (v == null || v === "") {
      if (f.default != null) {
        out[f.key] = f.default;
        continue;
      }
      if (f.required) return { ok: false, error: `${f.label} is required` };
      continue;
    }
    if (f.type === "enum") {
      if (!f.options.includes(v)) {
        return { ok: false, error: `${f.label} must be one of: ${f.options.join(", ")}` };
      }
    } else {
      if (typeof v !== "string") return { ok: false, error: `${f.label} must be a string` };
      v = v.trim();
      if (!v) {
        if (f.required) return { ok: false, error: `${f.label} is required` };
        continue;
      }
    }
    out[f.key] = v;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

function validateHeaders(headers) {
  if (headers == null) return { ok: true, value: null };
  if (typeof headers !== "object" || Array.isArray(headers)) {
    return { ok: false, error: "headers must be an object of string values" };
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== "string" || !k.trim()) {
      return { ok: false, error: "header names must be non-empty strings" };
    }
    if (typeof v !== "string") return { ok: false, error: `header "${k}" value must be a string` };
    out[k] = v;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

function validateRuleIds(ruleIds) {
  if (ruleIds == null) return { ok: true, value: null };
  if (!Array.isArray(ruleIds)) return { ok: false, error: "rule_ids must be an array" };
  for (const id of ruleIds) {
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: "rule_ids must be non-empty strings" };
    }
  }
  return { ok: true, value: ruleIds.length ? ruleIds : null };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/webhooks/providers - redacted provider catalog for the UI
router.get("/providers", (_req, res) => {
  res.json({ providers: publicProviders() });
});

// GET /api/webhooks - list targets (redacted)
router.get("/", (_req, res) => {
  res.json({ targets: stmts.listWebhookTargets.all().map(serializeTarget) });
});

// POST /api/webhooks - create a target
router.post("/", (req, res) => {
  const { name, type, url, enabled, secret, headers, rule_ids, config } = req.body || {};

  if (!name || typeof name !== "string" || !name.trim()) return bad(res, "name is required");
  if (!WEBHOOK_TYPES.includes(type)) {
    return bad(res, `type must be one of: ${WEBHOOK_TYPES.join(", ")}`);
  }

  // URL: required for some providers, derived/defaulted for others (Telegram,
  // Opsgenie, PagerDuty). Stored as "" when not user-supplied.
  let storedUrl = "";
  if (urlRequired(type)) {
    const u = validateUrl(url, type);
    if (!u.ok) return bad(res, u.error);
    storedUrl = u.url;
  } else if (url != null && String(url).trim()) {
    const u = validateUrl(url, type);
    if (!u.ok) return bad(res, u.error);
    storedUrl = u.url;
  }

  const cfg = validateConfig(type, config);
  if (!cfg.ok) return bad(res, cfg.error);

  // secret + custom headers only apply to the generic family.
  const generic = isGenericFamily(type);
  const h = validateHeaders(generic ? headers : null);
  if (!h.ok) return bad(res, h.error);
  const r = validateRuleIds(rule_ids);
  if (!r.ok) return bad(res, r.error);

  let sec = null;
  if (generic && secret != null) {
    if (typeof secret !== "string") return bad(res, "secret must be a string");
    sec = secret.trim() || null;
  }

  const id = uuidv4();
  stmts.insertWebhookTarget.run(
    id,
    name.trim(),
    type,
    storedUrl,
    enabled === false ? 0 : 1,
    sec,
    h.value ? JSON.stringify(h.value) : null,
    r.value ? JSON.stringify(r.value) : null,
    cfg.value ? JSON.stringify(cfg.value) : null
  );
  invalidateWebhookCache();
  res.status(201).json({ target: serializeTarget(stmts.getWebhookTarget.get(id)) });
});

// PATCH /api/webhooks/:id - partial update. url/secret/headers/rule_ids/config
// are only changed when their key is present in the body (omit = leave as-is).
router.patch("/:id", (req, res) => {
  const existing = stmts.getWebhookTarget.get(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Webhook target not found" } });
  }
  const body = req.body || {};
  const { name, url, enabled, secret, headers, rule_ids, config } = body;
  const generic = isGenericFamily(existing.type);

  if (name != null && (typeof name !== "string" || !name.trim())) {
    return bad(res, "name must be a non-empty string");
  }

  let urlVal = null;
  if (url != null) {
    const u = validateUrl(url, existing.type);
    if (!u.ok) return bad(res, u.error);
    urlVal = u.url;
  }

  // config: merge supplied fields over the existing config, then re-validate,
  // so e.g. region can change without re-sending the api_key.
  let configSet = 0;
  let configVal = null;
  if ("config" in body) {
    let base = {};
    try {
      base = existing.config ? JSON.parse(existing.config) : {};
    } catch {
      base = {};
    }
    const cfg = validateConfig(existing.type, config, base);
    if (!cfg.ok) return bad(res, cfg.error);
    configSet = 1;
    configVal = cfg.value ? JSON.stringify(cfg.value) : null;
  }

  let secretSet = 0;
  let secretVal = null;
  if ("secret" in body && generic) {
    if (secret !== null && typeof secret !== "string") {
      return bad(res, "secret must be a string or null");
    }
    secretSet = 1;
    secretVal = secret ? String(secret).trim() || null : null;
  }

  let headersSet = 0;
  let headersVal = null;
  if ("headers" in body && generic) {
    const h = validateHeaders(headers);
    if (!h.ok) return bad(res, h.error);
    headersSet = 1;
    headersVal = h.value ? JSON.stringify(h.value) : null;
  }

  let ruleSet = 0;
  let ruleVal = null;
  if ("rule_ids" in body) {
    const r = validateRuleIds(rule_ids);
    if (!r.ok) return bad(res, r.error);
    ruleSet = 1;
    ruleVal = r.value ? JSON.stringify(r.value) : null;
  }

  stmts.updateWebhookTarget.run(
    name != null ? name.trim() : null,
    urlVal,
    enabled == null ? null : enabled ? 1 : 0,
    secretSet,
    secretVal,
    headersSet,
    headersVal,
    ruleSet,
    ruleVal,
    configSet,
    configVal,
    req.params.id
  );
  invalidateWebhookCache();
  res.json({ target: serializeTarget(stmts.getWebhookTarget.get(req.params.id)) });
});

// DELETE /api/webhooks/:id - delete a target (its delivery log cascades away)
router.delete("/:id", (req, res) => {
  const existing = stmts.getWebhookTarget.get(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Webhook target not found" } });
  }
  stmts.deleteWebhookTarget.run(req.params.id);
  invalidateWebhookCache();
  res.json({ ok: true });
});

// POST /api/webhooks/:id/test - send a synthetic alert and report the result.
// Always 200 (the request itself succeeded); `ok` carries the delivery result.
router.post("/:id/test", async (req, res) => {
  const row = stmts.getWebhookTarget.get(req.params.id);
  if (!row) {
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Webhook target not found" } });
  }
  const result = await sendTest(normalizeTarget(row));
  res.json({
    ok: result.ok,
    status: result.status ?? null,
    attempts: result.attempts,
    error: result.error || null,
  });
});

// GET /api/webhooks/:id/deliveries - recent delivery log for a target
router.get("/:id/deliveries", (req, res) => {
  const row = stmts.getWebhookTarget.get(req.params.id);
  if (!row) {
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Webhook target not found" } });
  }
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const deliveries = stmts.listWebhookDeliveriesForTarget.all(req.params.id, limit, offset);
  res.json({ deliveries, limit, offset });
});

module.exports = router;
module.exports.WEBHOOK_TYPES = WEBHOOK_TYPES;
