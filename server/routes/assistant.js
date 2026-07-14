/**
 * @file assistant.js
 * @description HTTP routes for the voice/assistant surface (Phase D, §3.3 of
 * PLAN-jarvis-master.md). The single public endpoint - `POST /api/assistant/ask`
 * - powers Siri Shortcuts, CarPlay, the notes chat, and quick actions. It
 * returns `{ text, speech }` where `speech` is a short, spoken-style variant
 * Siri reads aloud.
 *
 * Auth model (deliberate, documented - NOT a same-origin exemption):
 *   - `/ask` requires a scoped **assistant bearer token** (Settings → Voice
 *     generates them; a Shortcut sends `Authorization: Bearer <token>`). It is
 *     exempted from the generic DASHBOARD_TOKEN gate (see security.js
 *     TOKEN_EXEMPT_PREFIXES) so a phone/Shortcut never carries the master
 *     dashboard token - only this revocable, per-purpose credential.
 *   - The dashboard's own first-party web UI (loopback / allowlisted Origin) may
 *     call `/ask` without minting a token; it is still gated by DASHBOARD_TOKEN
 *     when one is configured. A request with NO Origin (curl, Siri) MUST present
 *     an assistant token - the endpoint is never open.
 *   - The token-admin routes (`/tokens*`) are the opposite: NOT exempt (they sit
 *     behind DASHBOARD_TOKEN) plus a loopback same-origin guard, since only the
 *     web UI manages credentials.
 *
 * Rate limited in-process (ASSISTANT_RATE_LIMIT req / ASSISTANT_RATE_WINDOW_MS).
 *
 * @author Jarvis (Phase D)
 */

const { Router } = require("express");
const { handleAsk } = require("../lib/assistant");
const assistantActions = require("../lib/assistant-actions");
const { generateToken, listTokens, revokeToken } = require("../lib/assistant-token");
const { verifyToken } = require("../lib/assistant-token");
const {
  isLoopbackHostname,
  allowedHostnames,
  getDashboardToken,
  tokensMatch,
  extractToken,
} = require("../lib/security");
// Reuse the Run router's loopback same-origin guard for the credential-mutating
// admin routes (CSRF defense), rather than duplicating it.
const { __sameOriginGuard: sameOriginGuard } = require("./run");

const router = Router();

// ── Auth guard for /ask ──────────────────────────────────────────────────
const ALLOWED_SOURCES = new Set(["siri", "carplay", "chat", "notes", "quickaction"]);

function extractAssistantToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-assistant-token"];
  if (typeof header === "string" && header) return header.trim();
  return null;
}

function isFirstPartyOrigin(req) {
  const ok = (name) => {
    const n = String(name || "").toLowerCase();
    return isLoopbackHostname(n) || allowedHostnames().includes(n);
  };
  const check = (raw) => {
    try {
      return ok(new URL(raw).hostname);
    } catch {
      return false;
    }
  };
  if (req.headers.origin) return check(req.headers.origin);
  if (req.headers.referer) return check(req.headers.referer);
  return false; // no Origin/Referer → external caller → must present a token
}

function assistantAuthGuard(req, res, next) {
  const presented = extractAssistantToken(req);
  if (presented) {
    const id = verifyToken(presented);
    if (id) {
      req.assistantTokenId = id;
      return next();
    }
    // A presented-but-invalid token is a hard 401 - never fall through to the
    // first-party branch (defense against a leaked-then-revoked token).
    return res
      .status(401)
      .json({ error: { code: "EUNAUTHORIZED", message: "invalid assistant token" } });
  }
  // First-party web UI (built-in chat / notes / quick actions).
  if (isFirstPartyOrigin(req)) {
    const dash = getDashboardToken();
    if (!dash || tokensMatch(extractToken(req), dash)) return next();
    return res
      .status(401)
      .json({ error: { code: "EUNAUTHORIZED", message: "missing or invalid dashboard token" } });
  }
  return res.status(401).json({
    error: {
      code: "EUNAUTHORIZED",
      message: "assistant token required - generate one in Settings → Voice",
    },
  });
}

function dashboardOnly(req, res, next) {
  if (!req.assistantTokenId) return next();
  return res.status(403).json({
    error: { code: "EFORBIDDEN", message: "screen snapshots require the dashboard UI" },
  });
}

// ── Rate limiter (fixed window, in-process) ─────────────────────────────────
function envInt(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const RATE_MAX = envInt("ASSISTANT_RATE_LIMIT", 60);
const RATE_WINDOW_MS = envInt("ASSISTANT_RATE_WINDOW_MS", 60_000);
const buckets = new Map(); // key → { count, resetAt }

function rateLimit(req, res, next) {
  const key = req.assistantTokenId || req.ip || "anon";
  const now = Date.now();
  // Opportunistic prune so the map can't grow without bound.
  if (buckets.size > 1000) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retry));
    return res.status(429).json({
      error: { code: "ERATELIMIT", message: `rate limit exceeded - retry in ${retry}s` },
    });
  }
  return next();
}

// ── Admin: assistant token management (web UI only) ─────────────────────────
router.get("/tokens", sameOriginGuard, (_req, res) => {
  res.json({ tokens: listTokens() });
});

router.post("/tokens", sameOriginGuard, (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : undefined;
  const created = generateToken({ label });
  // `token` (plaintext) is present exactly once, here.
  res.status(201).json({ token: created });
});

router.delete("/tokens/:id", sameOriginGuard, (req, res) => {
  const ok = revokeToken(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: { code: "ENOTFOUND", message: "token not found" } });
  }
  return res.json({ ok: true });
});

// ── Public: the one endpoint that powers Siri / CarPlay / chat / quick actions
router.post("/ask", assistantAuthGuard, rateLimit, async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text : "";
  const source = ALLOWED_SOURCES.has(body.source) ? body.source : "chat";
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId
      ? body.conversationId.slice(0, 128)
      : null;
  // Additive (Phase M): a provider override and a light client context. Old
  // callers (Siri) omit both and get the same shape they always did.
  const provider = typeof body.provider === "string" ? body.provider : null;
  const context = body.context && typeof body.context === "object" ? body.context : {};
  if (!text.trim()) {
    return res.status(400).json({ error: { code: "EBADINPUT", message: "text is required" } });
  }
  try {
    const out = await handleAsk({ text, source, conversationId, provider, context });
    return res.json({
      text: out.text,
      speech: out.speech,
      intent: out.intent,
      source,
      conversationId: out.conversationId != null ? out.conversationId : conversationId,
      ...(out.provider ? { provider: out.provider } : {}),
      ...(out.taskClass ? { taskClass: out.taskClass } : {}),
      ...(out.data ? { data: out.data } : {}),
      ...(Array.isArray(out.actions) && out.actions.length ? { actions: out.actions } : {}),
      // Additive (bugfix): present only when the requested provider failed and
      // a fallback answered instead - old callers (Siri) ignore them and keep
      // working unmodified.
      ...(out.requestedProvider ? { requestedProvider: out.requestedProvider } : {}),
      ...(out.providerError ? { providerError: out.providerError } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: { code: "EINTERNAL", message: err.message } });
  }
});

// ── Confirm round-trip: execute one action from the popup (Phase M, §3.1). The
// popup calls this after the user taps a confirm chip (confirmToken) or retypes
// the action name (typedConfirm). Source is fixed to "chat" - the interactive
// surface - so the dispatcher's risk gate applies exactly. Client-side actions
// come back status:"done" for the browser to execute; server actions run here.
router.post("/action", assistantAuthGuard, rateLimit, async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    return res.status(400).json({ error: { code: "EBADINPUT", message: "name is required" } });
  }
  const params = body.params && typeof body.params === "object" ? body.params : {};
  const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken : undefined;
  const typedConfirm = typeof body.typedConfirm === "string" ? body.typedConfirm : undefined;
  try {
    const out = await assistantActions.dispatch({
      name,
      params,
      source: "chat",
      confirmToken,
      typedConfirm,
    });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: { code: "EINTERNAL", message: err.message } });
  }
});

// ── Glance (Phase T): one tiny JSON for home-screen widgets / Watch Shortcuts.
// Same auth model as /ask (assistant bearer token, or first-party origin) and
// exempted from the DASHBOARD_TOKEN gate for the same reason - a Shortcut
// carries only the revocable assistant token. Read-only; every field is
// derived from state other endpoints already expose.
router.get("/glance", assistantAuthGuard, rateLimit, (_req, res) => {
  const out = {
    runs: { live: 0, waitingOnPermission: 0 },
    agents: { working: 0, waiting: 0 },
    sessions: { active: 0 },
    // 5h-window usage from the shared cache (Phase P owns making this organic;
    // fields are null until any sample lands). resetsAt is an ISO timestamp so
    // widgets can render a live countdown client-side.
    window: { percentUsed: null, resetsAt: null, sampleAgeMs: null, source: null },
    captures: 0,
    at: new Date().toISOString(),
  };
  try {
    const live = require("../lib/run-spawner")
      .listRuns()
      .filter((r) => r.status === "running" || r.status === "spawning");
    out.runs.live = live.length;
    out.runs.waitingOnPermission = live.filter((r) =>
      (r.pendingPermissions || []).some((p) => p.status === "pending")
    ).length;
  } catch {
    /* run subsystem unavailable - zeros are honest */
  }
  try {
    const db = require("../db").db;
    out.agents.working = db
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'working'")
      .get().c;
    out.agents.waiting = db
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'waiting'")
      .get().c;
    out.sessions.active = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'")
      .get().c;
    out.captures = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_captures WHERE status = 'inbox'")
      .get().c;
  } catch {
    /* DB not ready */
  }
  try {
    const usageCache = require("../lib/usage-cache");
    const sample = usageCache.getCached();
    const info = sample && sample.rateLimitInfo;
    if (info) {
      out.window.percentUsed = usageCache.percentFromInfo(info);
      if (typeof info.resetsAt === "number") {
        out.window.resetsAt = new Date(info.resetsAt * 1000).toISOString();
      }
      out.window.sampleAgeMs = usageCache.sampleAgeMs();
      out.window.source = sample.source || null;
    }
  } catch {
    /* usage cache unavailable */
  }
  res.json(out);
});

// ── Browse (Phase Z): the latest streamed frame, so /browse can hydrate on mount
// (frames are broadcast during the action, before the popup deep-links over).
router.get("/browse/last", assistantAuthGuard, (_req, res) => {
  let frame = null;
  try {
    frame = require("../lib/browser").getLastFrame();
  } catch {
    frame = null;
  }
  res.json({ frame: frame || null });
});

// ── Computer use (Phase Z Tier 2): the latest streamed frame, so /computer-use
// can hydrate on mount (mirrors /browse/last above).
router.get("/computer-use/last", assistantAuthGuard, (_req, res) => {
  let frame = null;
  try {
    frame = require("../lib/computer-use").getLastFrame();
  } catch {
    frame = null;
  }
  res.json({ frame: frame || null });
});

// Native snapshot view: one authenticated request captures one Mac frame and
// broadcasts it over the existing computer_use_frame WebSocket channel.
router.post(
  "/computer-use/snapshot",
  assistantAuthGuard,
  dashboardOnly,
  rateLimit,
  async (_req, res) => {
    try {
      await require("../lib/computer-use").computerUse();
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: { code: "ECAPTURE", message: err.message } });
    }
  }
);

module.exports = router;
module.exports.__assistantAuthGuard = assistantAuthGuard;
module.exports.__dashboardOnly = dashboardOnly;
