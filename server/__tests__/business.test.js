/**
 * @file business.test.js
 * @description Phase BM - dormant business integrations (eBay/Amazon/Keepa/
 * SellerAmp). Verifies the config round-trip + secret redaction, the 503
 * NOT_CONNECTED gate on every operational endpoint while dormant, and the
 * client mappers against mocked upstream responses (injectable fetch - no
 * network).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "business-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.BUSINESS_CONFIG_PATH = path.join(TMP, "business.json");

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const config = require("../lib/business/config");
const clients = require("../lib/business/clients");

let server;
let BASE;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b || "{}") }));
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Fake fetch: routes URLs to canned responses; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        return {
          ok: (resp.status || 200) < 400,
          status: resp.status || 200,
          text: async () => JSON.stringify(resp.body),
        };
      }
    }
    return { ok: false, status: 404, text: async () => "{}" };
  };
  fn.calls = calls;
  return fn;
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("config store", () => {
  it("starts dormant: all providers disabled, no creds", async () => {
    const { status, body } = await req("GET", "/api/business/integrations");
    assert.equal(status, 200);
    for (const p of ["ebay", "amazon", "keepa"]) {
      assert.equal(body.providers[p].enabled, false);
      assert.equal(body.providers[p].connected, false);
    }
    assert.equal(body.providers.selleramp.hasCreds, true, "selleramp needs no creds");
  });

  it("round-trips credentials and redacts them to has* booleans", async () => {
    const put = await req("PUT", "/api/business/integrations/keepa", {
      apiKey: "k-secret",
      enabled: true,
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.hasApiKey, true);
    assert.equal(put.body.config.connected, true);
    assert.equal(put.body.config.apiKey, undefined, "secret never leaves the server");

    // Secret really is on disk, not in any response.
    const raw = JSON.parse(fs.readFileSync(process.env.BUSINESS_CONFIG_PATH, "utf8"));
    assert.equal(raw.keepa.apiKey, "k-secret");

    // Turn it back off for the gating tests below.
    await req("PUT", "/api/business/integrations/keepa", { enabled: false });
  });

  it("rejects unknown providers and unknown fields never land", async () => {
    const bad = await req("PUT", "/api/business/integrations/etsy", { enabled: true });
    assert.equal(bad.status, 400);
    await req("PUT", "/api/business/integrations/ebay", { evil: "x", clientId: "id-1" });
    const raw = JSON.parse(fs.readFileSync(process.env.BUSINESS_CONFIG_PATH, "utf8"));
    assert.equal(raw.ebay.evil, undefined);
    assert.equal(raw.ebay.clientId, "id-1");
  });
});

describe("dormant gating", () => {
  it("operational endpoints answer 503 NOT_CONNECTED while dormant", async () => {
    for (const p of [
      "/api/business/keepa/B000000000",
      "/api/business/amazon/B000000000",
      "/api/business/ebay/search?q=lego",
    ]) {
      const { status, body } = await req("GET", p);
      assert.equal(status, 503, p);
      assert.equal(body.error.code, "NOT_CONNECTED", p);
    }
    const listing = await req("POST", "/api/business/ebay/listing", { sku: "x" });
    assert.equal(listing.status, 503);
  });

  it("selleramp deep-link needs no connection", async () => {
    const { status, body } = await req("GET", "/api/business/selleramp/link?q=B0ABC123");
    assert.equal(status, 200);
    assert.match(body.url, /^https:\/\/sas\.selleramp\.com\/sas\/lookup\?/);
    assert.match(body.url, /B0ABC123/);
  });

  it("test endpoint refuses to fire without credentials", async () => {
    const { status } = await req("POST", "/api/business/integrations/amazon/test");
    assert.equal(status, 503);
  });
});

describe("clients against mocked upstreams", () => {
  it("keepa: maps prices (pence→GBP), rank and tokensLeft", async () => {
    config.updateProvider("keepa", { apiKey: "k", enabled: true });
    const current = new Array(19).fill(-1);
    current[0] = 1999; // AMAZON
    current[1] = 1899; // NEW
    current[3] = 5432; // SALES rank
    current[18] = 2099; // BUYBOX
    const fetchImpl = fakeFetch([
      [
        "api.keepa.com/product",
        {
          body: {
            tokensLeft: 280,
            products: [
              {
                asin: "B0TEST",
                title: "Test product",
                stats: { current, avg90: current, salesRankDrops30: 12, salesRankDrops90: 40 },
              },
            ],
          },
        },
      ],
    ]);
    const out = await clients.keepaProduct({ asin: "B0TEST" }, fetchImpl);
    assert.equal(out.ok, true);
    assert.equal(out.current.buyBox, 20.99);
    assert.equal(out.current.amazon, 19.99);
    assert.equal(out.current.salesRank, 5432);
    assert.equal(out.salesRankDrops30, 12);
    assert.equal(out.tokensLeft, 280);
    config.updateProvider("keepa", { enabled: false });
  });

  it("ebay: search fetches an app token then Browse results, honestly labelled", async () => {
    config.updateProvider("ebay", { clientId: "id", clientSecret: "sec", enabled: true });
    const fetchImpl = fakeFetch([
      ["identity/v1/oauth2/token", { body: { access_token: "app-tok" } }],
      [
        "buy/browse/v1/item_summary/search",
        {
          body: {
            total: 1,
            itemSummaries: [
              {
                itemId: "v1|1|0",
                title: "Lego 75301",
                price: { value: "34.99", currency: "GBP" },
                condition: "New",
                itemWebUrl: "https://ebay.co.uk/itm/1",
                seller: { username: "brickseller" },
                buyingOptions: ["FIXED_PRICE"],
              },
            ],
          },
        },
      ],
    ]);
    const out = await clients.ebaySearch({ q: "lego 75301" }, fetchImpl);
    assert.equal(out.ok, true);
    assert.equal(out.items[0].title, "Lego 75301");
    assert.match(out.note, /active listings/);
    // Token call authenticated with the basic keypair.
    assert.match(fetchImpl.calls[0].opts.headers.Authorization, /^Basic /);
    config.updateProvider("ebay", { enabled: false });
  });

  it("ebay: draft listing creates inventory item + offer but never publishes", async () => {
    config.updateProvider("ebay", {
      clientId: "id",
      clientSecret: "sec",
      refreshToken: "rt",
      enabled: true,
    });
    const fetchImpl = fakeFetch([
      ["identity/v1/oauth2/token", { body: { access_token: "user-tok" } }],
      ["sell/inventory/v1/inventory_item/SKU-1", { status: 204, body: {} }],
      ["sell/inventory/v1/offer", { body: { offerId: "offer-9" } }],
    ]);
    const out = await clients.ebayCreateDraftListing(
      { sku: "SKU-1", title: "Casio watch", price: 29.99 },
      fetchImpl
    );
    assert.equal(out.ok, true);
    assert.equal(out.offerId, "offer-9");
    assert.equal(out.published, false, "hard rule: human review before publish");
    assert.ok(
      !fetchImpl.calls.some((c) => c.url.includes("/publish")),
      "no publish call is ever made"
    );
    config.updateProvider("ebay", { enabled: false });
  });

  it("amazon: LWA token then catalog + offers for an ASIN", async () => {
    config.updateProvider("amazon", {
      lwaClientId: "c",
      lwaClientSecret: "s",
      refreshToken: "r",
      enabled: true,
    });
    const fetchImpl = fakeFetch([
      ["api.amazon.com/auth/o2/token", { body: { access_token: "lwa-tok" } }],
      ["catalog/2022-04-01/items/B0TEST", { body: { summaries: [{ itemName: "Thing" }] } }],
      ["products/pricing/v0/items/B0TEST/offers", { body: { payload: { Offers: [] } } }],
    ]);
    const out = await clients.amazonProduct({ asin: "B0TEST" }, fetchImpl);
    assert.equal(out.ok, true);
    assert.ok(out.catalog.summaries);
    assert.ok(out.offers.Offers);
    const spCall = fetchImpl.calls.find((c) => c.url.includes("catalog/2022-04-01"));
    assert.equal(spCall.opts.headers["x-amz-access-token"], "lwa-tok");
    config.updateProvider("amazon", { enabled: false });
  });

  it("clients report upstream failures as {ok:false} instead of throwing", async () => {
    config.updateProvider("keepa", { apiKey: "bad", enabled: true });
    const fetchImpl = fakeFetch([
      ["api.keepa.com/product", { status: 401, body: { error: "denied" } }],
    ]);
    const out = await clients.keepaProduct({ asin: "B0TEST" }, fetchImpl);
    assert.equal(out.ok, false);
    assert.equal(out.error.status, 401);
    config.updateProvider("keepa", { enabled: false });
  });
});
