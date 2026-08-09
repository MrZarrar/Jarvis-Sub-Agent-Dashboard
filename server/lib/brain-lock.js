/** Central persistence and cryptography for the server-enforced Brain PIN Lock. */

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { db } = require("../db");

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "jarvis_brain_session";
const VALID_TIMEOUTS = new Set([1, 5, 15, 30]);
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const HASH_BYTES = 64;

function error(code, message, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras });
}

function validPin(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

function requirePin(pin) {
  if (!validPin(pin)) throw error("EBADPIN", "PIN must contain exactly four digits");
}

function requireTimeout(timeoutMinutes) {
  if (!VALID_TIMEOUTS.has(timeoutMinutes)) {
    throw error("EBADTIMEOUT", "timeoutMinutes must be one of 1, 5, 15, or 30");
  }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function pinHash(pin, salt) {
  return Buffer.from(await scrypt(pin, salt, HASH_BYTES)).toString("hex");
}

function safeHexEqual(actual, expected) {
  try {
    const a = Buffer.from(String(actual), "hex");
    const b = Buffer.from(String(expected), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function config() {
  return db.prepare("SELECT * FROM brain_lock_config WHERE id = 1").get() || null;
}

function remainingSeconds(until, now = Date.now()) {
  if (!until) return 0;
  return Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
}

function cookieToken(req) {
  const raw = req.headers?.cookie;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name !== COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

function cookieOptions(req, timeoutMinutes) {
  const hostname = String(req.hostname || "").toLowerCase();
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", ""].includes(hostname);
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: Boolean(req.secure || !loopback),
    path: "/",
    maxAge: timeoutMinutes * 60 * 1000,
  };
}

function setSessionCookie(req, res, token, timeoutMinutes) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req, timeoutMinutes));
}

function clearSessionCookie(req, res) {
  const options = cookieOptions(req, 1);
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
}

function createSession(now = Date.now()) {
  const cfg = config();
  if (!cfg) throw error("ENOTCONFIGURED", "Brain PIN has not been configured");
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + cfg.timeout_minutes * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO brain_unlock_sessions (token_hash, created_at, last_activity_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash(token), createdAt, createdAt, expiresAt);
  return { token, timeoutMinutes: cfg.timeout_minutes, expiresAt };
}

async function setup(pin, timeoutMinutes = 5) {
  requirePin(pin);
  requireTimeout(timeoutMinutes);
  if (config()) throw error("EALREADYCONFIGURED", "Brain PIN is already configured");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await pinHash(pin, salt);
  db.prepare(
    `INSERT INTO brain_lock_config
      (id, pin_salt, pin_hash, failed_attempts, locked_until, timeout_minutes)
     VALUES (1, ?, ?, 0, NULL, ?)`
  ).run(salt, hash, timeoutMinutes);
  return createSession();
}

async function unlock(pin, now = Date.now()) {
  requirePin(pin);
  const cfg = config();
  if (!cfg) throw error("ENOTCONFIGURED", "Brain PIN has not been configured");
  const retryAfterSeconds = remainingSeconds(cfg.locked_until, now);
  if (retryAfterSeconds > 0) {
    throw error("EBRAINLOCKOUT", "Too many failed attempts", { retryAfterSeconds });
  }

  const candidate = await pinHash(pin, cfg.pin_salt);
  if (!safeHexEqual(candidate, cfg.pin_hash)) {
    db.prepare(
      `UPDATE brain_lock_config
       SET failed_attempts = failed_attempts + 1, locked_until = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`
    ).run();
    const failed = config().failed_attempts;
    if (failed >= MAX_FAILURES) {
      const lockedUntil = new Date(now + LOCKOUT_MS).toISOString();
      db.prepare("UPDATE brain_lock_config SET locked_until = ? WHERE id = 1").run(lockedUntil);
      throw error("EBRAINLOCKOUT", "Too many failed attempts", {
        retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
      });
    }
    throw error("EINVALIDPIN", "Invalid PIN", { attemptsRemaining: MAX_FAILURES - failed });
  }

  db.prepare(
    `UPDATE brain_lock_config SET failed_attempts = 0, locked_until = NULL,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`
  ).run();
  return createSession(now);
}

function authenticate(req, { touch = true, now = Date.now() } = {}) {
  const cfg = config();
  if (!cfg) return { configured: false, unlocked: false, timeoutMinutes: 5 };
  const token = cookieToken(req);
  if (!token) return { configured: true, unlocked: false, timeoutMinutes: cfg.timeout_minutes };
  const hash = tokenHash(token);
  const session = db.prepare("SELECT * FROM brain_unlock_sessions WHERE token_hash = ?").get(hash);
  if (!session || Date.parse(session.expires_at) <= now) {
    if (session) db.prepare("DELETE FROM brain_unlock_sessions WHERE token_hash = ?").run(hash);
    return { configured: true, unlocked: false, timeoutMinutes: cfg.timeout_minutes };
  }
  let expiresAt = session.expires_at;
  if (touch) {
    const activity = new Date(now).toISOString();
    expiresAt = new Date(now + cfg.timeout_minutes * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE brain_unlock_sessions SET last_activity_at = ?, expires_at = ? WHERE token_hash = ?"
    ).run(activity, expiresAt, hash);
  }
  return {
    configured: true,
    unlocked: true,
    token,
    tokenHash: hash,
    timeoutMinutes: cfg.timeout_minutes,
    expiresAt,
  };
}

function status(req) {
  const auth = authenticate(req);
  const cfg = config();
  return {
    configured: Boolean(cfg),
    unlocked: auth.unlocked,
    timeoutMinutes: cfg?.timeout_minutes || 5,
    lockoutRemainingSeconds: remainingSeconds(cfg?.locked_until),
  };
}

function lock(req) {
  const token = cookieToken(req);
  if (token)
    db.prepare("DELETE FROM brain_unlock_sessions WHERE token_hash = ?").run(tokenHash(token));
}

function updateSettings(timeoutMinutes) {
  requireTimeout(timeoutMinutes);
  if (!config()) throw error("ENOTCONFIGURED", "Brain PIN has not been configured");
  db.prepare(
    `UPDATE brain_lock_config SET timeout_minutes = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`
  ).run(timeoutMinutes);
  return config();
}

module.exports = {
  COOKIE_NAME,
  VALID_TIMEOUTS,
  MAX_FAILURES,
  LOCKOUT_MS,
  validPin,
  setup,
  unlock,
  authenticate,
  status,
  lock,
  updateSettings,
  setSessionCookie,
  clearSessionCookie,
};
