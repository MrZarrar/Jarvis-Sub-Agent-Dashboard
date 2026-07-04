/**
 * @file accounts.js
 * @description Read-only multi-account tracking API (Phase K). Surfaces the
 * unified claude-swap view: which account is active, each known account's
 * window/reset info when available, and recent swap history. The dashboard only
 * OBSERVES claude-swap - there is deliberately no swap-triggering endpoint here.
 */

const { Router } = require("express");

const router = Router();

/**
 * GET /api/accounts
 * → { present, activeAccountId, accounts: [...], swaps: [...] }
 * `present` is false when claude-swap isn't detected, so a single-account setup
 * gets an empty, inert payload and the UI can hide multi-account chrome.
 */
router.get("/", (_req, res) => {
  try {
    const { getAccountsState } = require("../lib/claude-swap");
    return res.json(getAccountsState());
  } catch {
    return res.json({ present: false, activeAccountId: null, accounts: [], swaps: [] });
  }
});

module.exports = router;
