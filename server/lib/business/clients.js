/**
 * @file business/clients.js
 * @description Thin API clients for the business integrations (Phase BM):
 * eBay (OAuth + Browse search + Sell draft listings), Amazon SP-API (LWA +
 * catalog/pricing), Keepa (product stats) and SellerAmp (deep-link builder -
 * it has no public API). All calls are server-side; every function takes an
 * injectable `fetchImpl` for tests, never throws, and returns
 * `{ ok, ... } | { ok:false, error }`.
 *
 * DORMANT: routes/business.js gates every call on config.isConnected(), so
 * none of this touches the network until the accounts are linked in Settings.
 * Built against the documented APIs; the sell-side calls are untested against
 * a live seller account until one exists - the /test endpoints exist exactly
 * so each can be verified the day the keys are pasted.
 *
 * @author Jarvis (Phase BM)
 */

const config = require("./config");

const fetchDefault = (...args) => globalThis.fetch(...args);

async function jsonOrText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function fail(step, res, body) {
  return {
    ok: false,
    error: {
      step,
      status: res ? res.status : 0,
      detail: (body && (body.error_description || body.message || body.errors || body.raw)) || null,
    },
  };
}

// ── eBay ─────────────────────────────────────────────────────────────────────

function ebayBase(cfg) {
  return cfg.environment === "SANDBOX" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function basicAuth(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

/** Application token (client-credentials) - enough for Browse API searches. */
async function ebayAppToken(fetchImpl = fetchDefault) {
  const cfg = config.getConfig().ebay;
  const res = await fetchImpl(`${ebayBase(cfg)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
    },
    body:
      "grant_type=client_credentials&scope=" +
      encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const body = await jsonOrText(res);
  if (!res.ok || !body.access_token) return fail("ebay app token", res, body);
  return { ok: true, token: body.access_token };
}

/** User token via the stored refresh token - needed for sell-side calls. */
async function ebayUserToken(fetchImpl = fetchDefault) {
  const cfg = config.getConfig().ebay;
  if (!cfg.refreshToken) {
    return { ok: false, error: { step: "ebay user token", detail: "no refresh token saved" } };
  }
  const res = await fetchImpl(`${ebayBase(cfg)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
    },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(cfg.refreshToken),
  });
  const body = await jsonOrText(res);
  if (!res.ok || !body.access_token) return fail("ebay user token", res, body);
  return { ok: true, token: body.access_token };
}

/** Active-listing comps via the Browse API (sold comps need the gated
 *  Marketplace Insights API - the UI/agents treat these as ASKING prices). */
async function ebaySearch({ q, limit = 10 }, fetchImpl = fetchDefault) {
  const cfg = config.getConfig().ebay;
  const tok = await ebayAppToken(fetchImpl);
  if (!tok.ok) return tok;
  const url =
    `${ebayBase(cfg)}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}` +
    `&limit=${Math.max(1, Math.min(50, Number(limit) || 10))}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${tok.token}`,
      "X-EBAY-C-MARKETPLACE-ID": cfg.marketplaceId,
    },
  });
  const body = await jsonOrText(res);
  if (!res.ok) return fail("ebay search", res, body);
  const items = (body.itemSummaries || []).map((i) => ({
    itemId: i.itemId,
    title: i.title,
    price: i.price ? { value: i.price.value, currency: i.price.currency } : null,
    condition: i.condition || null,
    itemWebUrl: i.itemWebUrl || null,
    seller: i.seller ? i.seller.username : null,
    buyingOptions: i.buyingOptions || [],
  }));
  return {
    ok: true,
    total: body.total || items.length,
    items,
    note: "active listings (asking prices), not sold comps",
  };
}

/**
 * Create an UNPUBLISHED draft listing: inventory item + offer, deliberately
 * without the publish call so every listing is reviewed by a human before it
 * goes live (underwriter hard rule). Requires the sell-side refresh token and
 * the business-policy ids in config.
 */
async function ebayCreateDraftListing(input, fetchImpl = fetchDefault) {
  const cfg = config.getConfig().ebay;
  const {
    sku,
    title,
    description,
    price,
    quantity = 1,
    condition = "USED_EXCELLENT",
    imageUrls = [],
  } = input || {};
  if (!sku || !title || !price) {
    return { ok: false, error: { step: "validate", detail: "sku, title and price are required" } };
  }
  const tok = await ebayUserToken(fetchImpl);
  if (!tok.ok) return tok;
  const headers = {
    Authorization: `Bearer ${tok.token}`,
    "Content-Type": "application/json",
    "Content-Language": "en-GB",
  };

  const invRes = await fetchImpl(
    `${ebayBase(cfg)}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        condition,
        product: { title, description: description || title, imageUrls },
        availability: { shipToLocationAvailability: { quantity } },
      }),
    }
  );
  if (!invRes.ok && invRes.status !== 204) {
    return fail("ebay inventory item", invRes, await jsonOrText(invRes));
  }

  const offerRes = await fetchImpl(`${ebayBase(cfg)}/sell/inventory/v1/offer`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sku,
      marketplaceId: cfg.marketplaceId,
      format: "FIXED_PRICE",
      availableQuantity: quantity,
      pricingSummary: { price: { value: String(price), currency: "GBP" } },
      listingDescription: description || title,
      listingPolicies: {
        fulfillmentPolicyId: cfg.fulfillmentPolicyId || undefined,
        paymentPolicyId: cfg.paymentPolicyId || undefined,
        returnPolicyId: cfg.returnPolicyId || undefined,
      },
      merchantLocationKey: cfg.merchantLocationKey || undefined,
    }),
  });
  const offerBody = await jsonOrText(offerRes);
  if (!offerRes.ok) return fail("ebay offer", offerRes, offerBody);
  return {
    ok: true,
    sku,
    offerId: offerBody.offerId || null,
    published: false,
    note: "draft only - publish from Seller Hub after human review",
  };
}

// ── Amazon SP-API ────────────────────────────────────────────────────────────

/** Login-with-Amazon access token from the stored refresh token. Modern SP-API
 *  needs only this bearer for the catalog/pricing calls used here (no SigV4). */
async function amazonAccessToken(fetchImpl = fetchDefault) {
  const cfg = config.getConfig().amazon;
  const res = await fetchImpl("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.lwaClientId,
      client_secret: cfg.lwaClientSecret,
    }).toString(),
  });
  const body = await jsonOrText(res);
  if (!res.ok || !body.access_token) return fail("amazon lwa token", res, body);
  return { ok: true, token: body.access_token };
}

/** Catalog summary + current offers for one ASIN (the underwriter's inputs). */
async function amazonProduct({ asin }, fetchImpl = fetchDefault) {
  const cfg = config.getConfig().amazon;
  if (!asin) return { ok: false, error: { step: "validate", detail: "asin is required" } };
  const tok = await amazonAccessToken(fetchImpl);
  if (!tok.ok) return tok;
  const headers = { "x-amz-access-token": tok.token };

  const out = { ok: true, asin, catalog: null, offers: null };
  const catRes = await fetchImpl(
    `${cfg.endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${cfg.marketplaceId}&includedData=summaries,salesRanks`,
    { headers }
  );
  const catBody = await jsonOrText(catRes);
  if (catRes.ok) out.catalog = catBody;
  else out.catalogError = fail("amazon catalog", catRes, catBody).error;

  const offRes = await fetchImpl(
    `${cfg.endpoint}/products/pricing/v0/items/${encodeURIComponent(asin)}/offers` +
      `?MarketplaceId=${cfg.marketplaceId}&ItemCondition=New`,
    { headers }
  );
  const offBody = await jsonOrText(offRes);
  if (offRes.ok) out.offers = offBody.payload || offBody;
  else out.offersError = fail("amazon offers", offRes, offBody).error;

  if (!out.catalog && !out.offers) {
    return { ok: false, error: out.catalogError || out.offersError };
  }
  return out;
}

// ── Keepa ────────────────────────────────────────────────────────────────────

// Keepa stats.current / stats.avg90 array indices (documented product CSV
// order): 0 AMAZON, 1 NEW, 3 SALES rank, 18 BUY_BOX_SHIPPING. Prices are in
// pence for domain 2 (amazon.co.uk); -1 means "none".
const KEEPA_IDX = { AMAZON: 0, NEW: 1, SALES: 3, BUYBOX: 18 };

function keepaPrice(arr, idx) {
  const v = Array.isArray(arr) && Number.isFinite(arr[idx]) ? arr[idx] : -1;
  return v >= 0 ? v / 100 : null; // pence → GBP
}

/** 90-day product stats for one ASIN, trimmed to what the underwriter needs. */
async function keepaProduct({ asin }, fetchImpl = fetchDefault) {
  const cfg = config.getConfig().keepa;
  if (!asin) return { ok: false, error: { step: "validate", detail: "asin is required" } };
  const url =
    `https://api.keepa.com/product?key=${encodeURIComponent(cfg.apiKey)}` +
    `&domain=${cfg.domain}&asin=${encodeURIComponent(asin)}&stats=90&history=0&buybox=1`;
  const res = await fetchImpl(url);
  const body = await jsonOrText(res);
  if (!res.ok || !Array.isArray(body.products)) return fail("keepa product", res, body);
  const p = body.products[0];
  if (!p) return { ok: false, error: { step: "keepa product", detail: "asin not found" } };
  const stats = p.stats || {};
  return {
    ok: true,
    asin: p.asin,
    title: p.title || null,
    current: {
      buyBox: keepaPrice(stats.current, KEEPA_IDX.BUYBOX),
      amazon: keepaPrice(stats.current, KEEPA_IDX.AMAZON),
      new: keepaPrice(stats.current, KEEPA_IDX.NEW),
      salesRank: Array.isArray(stats.current) ? stats.current[KEEPA_IDX.SALES] : null,
    },
    avg90: {
      buyBox: keepaPrice(stats.avg90, KEEPA_IDX.BUYBOX),
      amazon: keepaPrice(stats.avg90, KEEPA_IDX.AMAZON),
      new: keepaPrice(stats.avg90, KEEPA_IDX.NEW),
      salesRank: Array.isArray(stats.avg90) ? stats.avg90[KEEPA_IDX.SALES] : null,
    },
    salesRankDrops30: stats.salesRankDrops30 ?? null,
    salesRankDrops90: stats.salesRankDrops90 ?? null,
    tokensLeft: body.tokensLeft ?? null,
  };
}

/** Cheap credential check: the /token endpoint reports the remaining quota. */
async function keepaTokenStatus(fetchImpl = fetchDefault) {
  const cfg = config.getConfig().keepa;
  const res = await fetchImpl(`https://api.keepa.com/token?key=${encodeURIComponent(cfg.apiKey)}`);
  const body = await jsonOrText(res);
  if (!res.ok || body.tokensLeft === undefined) return fail("keepa token", res, body);
  return { ok: true, tokensLeft: body.tokensLeft };
}

// ── SellerAmp ────────────────────────────────────────────────────────────────

// ponytail: SellerAmp SAS has no public API - a deep link into its lookup page
// is the whole integration. Upgrade path: none known; revisit if they ship one.
function sellerampLookupUrl(term) {
  return (
    "https://sas.selleramp.com/sas/lookup?" +
    new URLSearchParams({ "SasLookup[search_term]": String(term || "") }).toString()
  );
}

// ── Connection tests (wired to the Settings "Test" buttons) ─────────────────

async function testConnection(provider, fetchImpl = fetchDefault) {
  switch (provider) {
    case "ebay": {
      const app = await ebayAppToken(fetchImpl);
      if (!app.ok) return app;
      // Sell-side is a separate credential (refresh token) - report both.
      const cfg = config.getConfig().ebay;
      if (!cfg.refreshToken)
        return { ok: true, detail: "app token OK; no sell-side refresh token yet" };
      const user = await ebayUserToken(fetchImpl);
      return user.ok ? { ok: true, detail: "app + sell tokens OK" } : user;
    }
    case "amazon": {
      const tok = await amazonAccessToken(fetchImpl);
      return tok.ok ? { ok: true, detail: "LWA token OK" } : tok;
    }
    case "keepa":
      return keepaTokenStatus(fetchImpl);
    case "selleramp":
      return { ok: true, detail: "deep-links only - nothing to test" };
    default:
      return { ok: false, error: { step: "test", detail: `unknown provider: ${provider}` } };
  }
}

module.exports = {
  ebayAppToken,
  ebayUserToken,
  ebaySearch,
  ebayCreateDraftListing,
  amazonAccessToken,
  amazonProduct,
  keepaProduct,
  keepaTokenStatus,
  sellerampLookupUrl,
  testConnection,
  KEEPA_IDX,
};
