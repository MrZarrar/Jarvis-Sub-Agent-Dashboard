/** Default-deny API middleware for all data that could reveal brain content. */

const brainLock = require("./brain-lock");

const EXEMPT_PREFIXES = [
  "/brain-lock",
  "/health",
  "/openapi.json",
  "/docs",
  "/hooks",
  "/providers/capabilities",
  "/updates",
];

function exempt(path) {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function brainLockGuard(req, res, next) {
  if (process.env.NODE_TEST_CONTEXT && process.env.JARVIS_TEST_BRAIN_LOCK !== "1") return next();
  if (exempt(req.path)) return next();
  const auth = brainLock.authenticate(req);
  if (!auth.unlocked) {
    const state = brainLock.status(req);
    return res.status(423).json({
      error: {
        code: "EBRAINLOCKED",
        message: "Brain locked",
        configured: state.configured,
        retryAfterSeconds: state.lockoutRemainingSeconds,
      },
    });
  }
  brainLock.setSessionCookie(req, res, auth.token, auth.timeoutMinutes);
  req.brainSession = auth;
  return next();
}

module.exports = { brainLockGuard, EXEMPT_PREFIXES };
