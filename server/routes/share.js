/**
 * @file share.js
 * @description PWA share-sheet target (Phase T of PLAN-jarvis-v2.md). The
 * manifest's `share_target` posts shared text/URLs here as a top-level
 * multipart form navigation; the shared content lands in the assistant
 * capture inbox (`assistant_captures`, source "share") - the same inbox
 * voice "note:" captures drain into - and the browser is redirected to the
 * Notes page, where the captures banner surfaces it.
 *
 * Auth (deliberate): an OS-initiated share navigation cannot carry a bearer
 * token, so this route is exempt from the DASHBOARD_TOKEN gate (see
 * security.js TOKEN_EXEMPT_PREFIXES). The exposure is bounded: it accepts
 * only small text fields (8KB cap), writes only inbox rows the user triages,
 * and executes through the action dispatcher (audited, risk "safe").
 *
 * Files are NOT accepted yet - the chat upload path is Phase Q1; add a
 * `files` param here once that lands.
 */

const { Router } = require("express");
const express = require("express");
const multer = require("multer");
const assistantActions = require("../lib/assistant-actions");

const router = Router();
const MAX_TEXT = 8 * 1024;

router.post(
  "/",
  express.urlencoded({ extended: false, limit: "16kb" }),
  multer({ limits: { fieldSize: MAX_TEXT, fields: 8, files: 0 } }).none(),
  async (req, res) => {
    const body = req.body || {};
    const parts = ["title", "text", "url"]
      .map((k) => (typeof body[k] === "string" ? body[k].trim() : ""))
      .filter(Boolean);
    const text = parts.join("\n").slice(0, MAX_TEXT);
    if (!text) {
      return res.status(400).json({ error: { code: "EBADINPUT", message: "nothing shared" } });
    }
    try {
      const out = await assistantActions.dispatch({
        name: "write_note",
        params: { text },
        source: "share",
      });
      if (out.status !== "done") {
        return res
          .status(500)
          .json({ error: { code: "EINTERNAL", message: out.error || "capture failed" } });
      }
    } catch (err) {
      return res.status(500).json({ error: { code: "EINTERNAL", message: err.message } });
    }
    // 303 turns the share POST into a GET of the Notes page, whose captures
    // banner shows the new item.
    return res.redirect(303, "/notes");
  }
);

module.exports = router;
