/**
 * @file assistant-token.js
 * @description Long-lived bearer tokens for the voice/assistant endpoint
 * (Phase D, §3.3 of PLAN-jarvis-master.md). The single `POST /api/assistant/ask`
 * route — which powers Siri Shortcuts, CarPlay, the notes chat, and quick
 * actions — is NOT exempted from auth; instead each caller carries one of these
 * scoped, revocable tokens. The Settings → Voice card generates them; a Siri
 * Shortcut stores one and sends it as `Authorization: Bearer <token>`.
 *
 * Security model:
 *   - Only a SHA-256 hash of the token is persisted (`assistant_tokens`), so a
 *     leaked database never yields a usable token. The plaintext is returned to
 *     the caller exactly ONCE, at creation.
 *   - Verification is a single indexed hash lookup — an attacker cannot mount a
 *     timing attack against the secret because they would need a preimage of a
 *     stored hash, not a byte-by-byte comparison against the plaintext.
 *   - This is a scoped credential distinct from DASHBOARD_TOKEN: distributing it
 *     to a phone/Shortcut never exposes the master dashboard token, and it can
 *     be revoked independently.
 *
 * @author Jarvis (Phase D)
 */

const crypto = require("node:crypto");
const { randomUUID } = crypto;

// 32 bytes → ~43 url-safe chars. Long enough to be unguessable; short enough to
// paste into a Shortcut once.
const TOKEN_BYTES = 32;
const PREFIX_LEN = 6;
const MAX_LABEL_LEN = 80;

function db() {
  // Lazy require so this module never forces db.js to load before it is ready
  // (mirrors the pattern used by other lib modules).
  return require("../db").db;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function normalizeLabel(label) {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LEN) : null;
}

/**
 * Create a new assistant token. Returns the full row PLUS the plaintext `token`
 * — the only time it is ever available. Store it in the Shortcut immediately.
 */
function generateToken({ label } = {}) {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const id = randomUUID();
  const prefix = raw.slice(0, PREFIX_LEN);
  const cleanLabel = normalizeLabel(label);
  db()
    .prepare(
      "INSERT INTO assistant_tokens (id, token_hash, token_prefix, label) VALUES (?, ?, ?, ?)"
    )
    .run(id, sha256(raw), prefix, cleanLabel);
  const row = db()
    .prepare(
      "SELECT id, token_prefix AS prefix, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM assistant_tokens WHERE id = ?"
    )
    .get(id);
  return { ...row, token: raw };
}

/** All tokens, most-recent first. Never includes the secret or its hash. */
function listTokens() {
  return db()
    .prepare(
      "SELECT id, token_prefix AS prefix, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM assistant_tokens ORDER BY created_at DESC"
    )
    .all();
}

/**
 * Verify a presented token. Returns the matching token id (and bumps
 * last_used_at, best-effort) or null. A too-short presented value short-circuits
 * to null so obviously-bogus input never hits the DB.
 */
function verifyToken(presented) {
  if (typeof presented !== "string" || presented.length < 20) return null;
  const row = db()
    .prepare("SELECT id FROM assistant_tokens WHERE token_hash = ?")
    .get(sha256(presented));
  if (!row) return null;
  try {
    db()
      .prepare(
        "UPDATE assistant_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      )
      .run(row.id);
  } catch {
    /* last_used_at is a nicety — never fail auth over it */
  }
  return row.id;
}

/** Delete a token by id. Returns true if a row was removed. */
function revokeToken(id) {
  if (typeof id !== "string" || !id) return false;
  return db().prepare("DELETE FROM assistant_tokens WHERE id = ?").run(id).changes > 0;
}

/** Whether any assistant token exists (used by the UI to prompt first-time setup). */
function hasAnyToken() {
  return db().prepare("SELECT COUNT(*) AS c FROM assistant_tokens").get().c > 0;
}

module.exports = {
  generateToken,
  listTokens,
  verifyToken,
  revokeToken,
  hasAnyToken,
  // exported for tests
  sha256,
};
