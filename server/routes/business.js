/**
 * @file Express router for the business integrations (Phase BM): eBay, Amazon
 * SP-API, Keepa and SellerAmp. Config/status/test endpoints power the Settings
 * UI; the operational endpoints are the surface the ~/JarvisBusiness agents
 * curl (deal-scout/underwriter/lister). Everything operational is gated on
 * config.isConnected(provider) and answers 503 NOT_CONNECTED while the
 * integrations remain dormant - linking the accounts later in Settings flips
 * them live with no code change.
 * @author Jarvis (Phase BM)
 */

const { Router } = require("express");
const config = require("../lib/business/config");
const clients = require("../lib/business/clients");

const router = Router();

function notConnected(res, provider) {
  return res.status(503).json({
    error: {
      code: "NOT_CONNECTED",
      message: `${provider} integration is not connected - enable it and save credentials in Settings → Business integrations`,
    },
  });
}

function requireConnected(provider) {
  return (req, res, next) => {
    if (!config.isConnected(provider)) return notConnected(res, provider);
    next();
  };
}

/** Send a client result: upstream failures surface as 502 with the step. */
function send(res, result) {
  if (result && result.ok) return res.json(result);
  res.status(502).json({ error: { code: "UPSTREAM", ...((result && result.error) || {}) } });
}

// ── Config / status / test ──────────────────────────────────────────────────

router.get("/integrations", (req, res) => {
  res.json({ providers: config.redactedConfig() });
});

router.put("/integrations/:provider", (req, res) => {
  try {
    const view = config.updateProvider(req.params.provider, req.body || {});
    res.json({ provider: req.params.provider, config: view });
  } catch (err) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: err.message } });
  }
});

router.post("/integrations/:provider/test", async (req, res) => {
  const provider = req.params.provider;
  if (!config.PROVIDERS.includes(provider)) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown provider" } });
  }
  if (!config.hasCreds(provider)) return notConnected(res, provider);
  try {
    send(res, await clients.testConnection(provider));
  } catch (err) {
    res.status(502).json({ error: { code: "UPSTREAM", message: err.message } });
  }
});

// ── Operational endpoints (curl-able by the business agents) ────────────────

router.get("/keepa/:asin", requireConnected("keepa"), async (req, res) => {
  send(res, await clients.keepaProduct({ asin: req.params.asin }));
});

router.get("/amazon/:asin", requireConnected("amazon"), async (req, res) => {
  send(res, await clients.amazonProduct({ asin: req.params.asin }));
});

router.get("/ebay/search", requireConnected("ebay"), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "q is required" } });
  send(res, await clients.ebaySearch({ q, limit: req.query.limit }));
});

router.post("/ebay/listing", requireConnected("ebay"), async (req, res) => {
  send(res, await clients.ebayCreateDraftListing(req.body || {}));
});

// SellerAmp is a deep-link builder (no API, no creds) - always available.
router.get("/selleramp/link", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "q is required" } });
  res.json({ url: clients.sellerampLookupUrl(q) });
});

module.exports = router;
