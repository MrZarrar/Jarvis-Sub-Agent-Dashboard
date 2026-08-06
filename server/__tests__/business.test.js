const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-business-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.BUSINESS_CONFIG_PATH = path.join(TMP, "business.json");

const { createApp, startServer } = require("../index");
const { db } = require("../db");

let server;
let baseUrl;

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
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
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("dormant business integrations", () => {
  it("starts disabled and redacts saved credentials", async () => {
    const initial = await request("GET", "/api/business/integrations");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.providers.keepa.connected, false);

    const saved = await request("PUT", "/api/business/integrations/keepa", {
      apiKey: "anonymous-test-secret",
      enabled: true,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.hasApiKey, true);
    assert.equal(saved.body.config.connected, true);
    assert.equal(saved.body.config.apiKey, undefined);
    assert.equal(JSON.stringify(saved.body).includes("anonymous-test-secret"), false);
  });

  it("guards operational endpoints while their provider is disabled", async () => {
    await request("PUT", "/api/business/integrations/keepa", { enabled: false });
    for (const pathname of [
      "/api/business/keepa/B000000000",
      "/api/business/amazon/B000000000",
      "/api/business/ebay/search?q=anonymous",
    ]) {
      const result = await request("GET", pathname);
      assert.equal(result.status, 503, pathname);
      assert.equal(result.body.error.code, "NOT_CONNECTED", pathname);
    }
  });

  it("builds SellerAmp lookup links without pretending there is an API", async () => {
    const result = await request("GET", "/api/business/selleramp/link?q=B0ANON123");
    assert.equal(result.status, 200);
    assert.match(result.body.url, /^https:\/\/sas\.selleramp\.com\/sas\/lookup\?/);
    assert.match(result.body.url, /B0ANON123/);
  });
});
