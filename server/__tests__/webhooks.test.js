/**
 * @file Tests for the universal webhook delivery layer: payload formatting per
 * platform (slack/discord/teams/generic), HMAC signing, target CRUD with secret
 * redaction, validation, the synchronous test probe, rule-scoped dispatch,
 * disabled-target skipping, retry/backoff with delivery-log recording, and the
 * clear-data wipe.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

// Test DB + fast retry tunables must be set BEFORE requiring server modules
// (server/lib/webhooks.js reads the WEBHOOK_* env at module load).
const TEST_DB = path.join(os.tmpdir(), `dashboard-webhooks-test-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.JARVIS_ENV_PROFILE = "production-company-core";
process.env.JARVIS_ENABLE_PRODUCTION_CORE = "1";
process.env.WEBHOOK_MAX_ATTEMPTS = "2";
process.env.WEBHOOK_RETRY_BASE_MS = "10";
process.env.WEBHOOK_TIMEOUT_MS = "3000";

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const webhooks = require("../lib/webhooks");
const providers = require("../lib/webhook-providers");

let server;
let BASE;

// Mock receiver - records every inbound request; behavior is tunable per-test.
const received = [];
let nextStatus = 200;
let nextBody = "ok"; // response body the mock returns (for body-veto tests)
let failTimes = 0; // respond 500 this many times before honoring nextStatus
let recvServer;
let RECV_URL;

function resetReceiver() {
  received.length = 0;
  nextStatus = 200;
  nextBody = "ok";
  failTimes = 0;
}

// Wipe all targets/deliveries between tests so an enabled target from one test
// never receives another test's dispatch (which would also fire real requests
// at example.com URLs from the CRUD tests).
beforeEach(() => {
  db.prepare("DELETE FROM webhook_deliveries").run();
  db.prepare("DELETE FROM webhook_targets").run();
  webhooks.invalidateWebhookCache();
  resetReceiver();
});

function fetchJson(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...options.headers },
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const post = (p, body) => fetchJson(p, { method: "POST", body });
const patch = (p, body) => fetchJson(p, { method: "PATCH", body });
const del = (p) => fetchJson(p, { method: "DELETE" });

const SAMPLE_ALERT = {
  id: 42,
  rule_id: "rule-abc",
  rule_name: "Too many errors",
  rule_type: "event_pattern",
  session_id: "sess-1",
  agent_id: "agent-1",
  message: "5 matching events in 2 min (threshold 5)",
  details: JSON.stringify({ observed_count: 5 }),
  triggered_at: "2026-06-10T12:00:00.000Z",
};

before(async () => {
  recvServer = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(b);
      } catch {
        parsed = b;
      }
      received.push({ method: req.method, headers: req.headers, body: parsed });
      let status = nextStatus;
      if (failTimes > 0) {
        failTimes -= 1;
        status = 500;
      }
      res.statusCode = status;
      res.end(nextBody);
    });
  });
  await new Promise((r) => recvServer.listen(0, "127.0.0.1", r));
  RECV_URL = `http://127.0.0.1:${recvServer.address().port}/hook`;

  const app = createApp();
  server = await startServer(app, 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (recvServer) recvServer.close();
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

describe("payload formatting", () => {
  it("slack: header + section + context blocks with fallback text", () => {
    const p = webhooks.formatPayload("slack", SAMPLE_ALERT);
    assert.ok(p.text.includes("Too many errors"));
    assert.equal(p.blocks[0].type, "header");
    assert.equal(p.blocks[1].type, "section");
    assert.equal(p.blocks[2].type, "context");
    assert.ok(p.blocks[1].text.text.includes("threshold 5"));
  });

  it("discord: single rich embed with fields", () => {
    const p = webhooks.formatPayload("discord", SAMPLE_ALERT);
    assert.equal(p.embeds.length, 1);
    assert.ok(p.embeds[0].title.includes("Too many errors"));
    assert.equal(p.embeds[0].timestamp, SAMPLE_ALERT.triggered_at);
    assert.ok(p.embeds[0].fields.some((f) => f.name === "Session"));
  });

  it("teams: Adaptive Card wrapped in the Workflows message envelope", () => {
    const p = webhooks.formatPayload("teams", SAMPLE_ALERT);
    assert.equal(p.type, "message");
    assert.equal(p.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
    const card = p.attachments[0].content;
    assert.equal(card.type, "AdaptiveCard");
    const factSet = card.body.find((b) => b.type === "FactSet");
    assert.ok(factSet.facts.some((f) => f.title === "Type"));
  });

  it("generic: stable envelope with parsed details", () => {
    const p = webhooks.formatPayload("generic", SAMPLE_ALERT);
    assert.equal(p.event, "alert.triggered");
    assert.equal(p.alert.rule_name, "Too many errors");
    assert.deepEqual(p.alert.details, { observed_count: 5 });
  });

  it("generic: HMAC signature header when secret set", () => {
    const target = { type: "generic", url: "https://x.test", secret: "s3cr3t" };
    const { body, headers } = webhooks.buildRequest(target, SAMPLE_ALERT);
    const ts = headers["X-Webhook-Timestamp"];
    const expected =
      "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${body}`).digest("hex");
    assert.equal(headers["X-Webhook-Signature"], expected);
  });

  it("generic: custom headers cannot clobber Content-Type or signature", () => {
    const target = {
      type: "generic",
      url: "https://x.test",
      headers: { "Content-Type": "text/plain", "X-Webhook-Signature": "fake", "X-Custom": "ok" },
    };
    const { headers } = webhooks.buildRequest(target, SAMPLE_ALERT);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["X-Custom"], "ok");
    assert.notEqual(headers["X-Webhook-Signature"], "fake");
  });
});

describe("target CRUD + redaction", () => {
  it("creates a generic target and never returns the raw url/secret", async () => {
    const res = await post("/api/webhooks", {
      name: "My endpoint",
      type: "generic",
      url: "https://example.com/hook/SECRET-TOKEN-1234",
      secret: "signing-secret",
      headers: { Authorization: "Bearer abc" },
    });
    assert.equal(res.status, 201);
    const t = res.body.target;
    assert.equal(t.name, "My endpoint");
    assert.equal(t.has_secret, true);
    assert.ok(!("secret" in t));
    assert.ok(!t.url_preview.includes("SECRET-TOKEN"));
    assert.ok(t.url_preview.includes("example.com"));
    assert.deepEqual(t.headers, { Authorization: "••••" }); // value masked
  });

  it("rejects an invalid url and a bad type", async () => {
    const r1 = await post("/api/webhooks", { name: "x", type: "generic", url: "not a url" });
    assert.equal(r1.status, 400);
    const r2 = await post("/api/webhooks", {
      name: "x",
      type: "carrier-pigeon",
      url: "https://x.io",
    });
    assert.equal(r2.status, 400);
  });

  it("requires https for slack/discord/teams", async () => {
    const r = await post("/api/webhooks", {
      name: "x",
      type: "slack",
      url: "http://insecure.test/x",
    });
    assert.equal(r.status, 400);
  });

  it("patches enabled without touching the url/secret", async () => {
    const created = await post("/api/webhooks", {
      name: "patch-me",
      type: "generic",
      url: "https://example.com/abc",
      secret: "keep-me",
    });
    const id = created.body.target.id;
    const res = await patch(`/api/webhooks/${id}`, { enabled: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.target.enabled, false);
    assert.equal(res.body.target.has_secret, true); // secret preserved
    // raw row still has the secret
    assert.equal(stmts.getWebhookTarget.get(id).secret, "keep-me");
  });

  it("deletes a target", async () => {
    const created = await post("/api/webhooks", {
      name: "delete-me",
      type: "generic",
      url: "https://example.com/del",
    });
    const id = created.body.target.id;
    const res = await del(`/api/webhooks/${id}`);
    assert.equal(res.status, 200);
    assert.equal(stmts.getWebhookTarget.get(id), undefined);
  });
});

describe("delivery", () => {
  it("dispatches a fired alert to an enabled target with the generic payload", async () => {
    resetReceiver();
    const created = await post("/api/webhooks", {
      name: "live",
      type: "generic",
      url: RECV_URL,
    });
    await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.equal(received.length, 1);
    assert.equal(received[0].body.event, "alert.triggered");
    assert.equal(received[0].body.alert.rule_name, "Too many errors");
    // a success delivery row was recorded
    const last = stmts.lastWebhookDeliveryForTarget.get(created.body.target.id);
    assert.equal(last.status, "success");
  });

  it("skips disabled targets", async () => {
    resetReceiver();
    const created = await post("/api/webhooks", {
      name: "off",
      type: "generic",
      url: RECV_URL,
      enabled: false,
    });
    await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.equal(received.length, 0);
    assert.equal(stmts.lastWebhookDeliveryForTarget.get(created.body.target.id), undefined);
  });

  it("honors rule_ids scoping", async () => {
    resetReceiver();
    await post("/api/webhooks", {
      name: "scoped",
      type: "generic",
      url: RECV_URL,
      rule_ids: ["some-other-rule"],
    });
    await webhooks.dispatchAlert(SAMPLE_ALERT); // rule_id "rule-abc" not in scope
    assert.equal(received.length, 0);
  });

  it("retries on 5xx then records success", async () => {
    resetReceiver();
    failTimes = 1; // first attempt 500, second 200
    const created = await post("/api/webhooks", {
      name: "retry",
      type: "generic",
      url: RECV_URL,
    });
    await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.equal(received.length, 2); // one failed + one retried
    const last = stmts.lastWebhookDeliveryForTarget.get(created.body.target.id);
    assert.equal(last.status, "success");
    assert.equal(last.attempts, 2);
  });

  it("records a failure when all attempts return 5xx", async () => {
    resetReceiver();
    nextStatus = 500;
    failTimes = 0;
    const created = await post("/api/webhooks", {
      name: "fail",
      type: "generic",
      url: RECV_URL,
    });
    const settled = await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.equal(settled[0].value.ok, false);
    const last = stmts.lastWebhookDeliveryForTarget.get(created.body.target.id);
    assert.equal(last.status, "failed");
    assert.equal(last.status_code, 500);
  });

  it("does not retry on 4xx", async () => {
    resetReceiver();
    nextStatus = 400;
    const created = await post("/api/webhooks", {
      name: "badreq",
      type: "generic",
      url: RECV_URL,
    });
    await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.equal(received.length, 1); // no retry
    assert.equal(stmts.lastWebhookDeliveryForTarget.get(created.body.target.id).status, "failed");
  });
});

describe("test probe + clear-data", () => {
  it("POST /:id/test delivers a synthetic alert and reports ok", async () => {
    resetReceiver();
    const created = await post("/api/webhooks", {
      name: "probe",
      type: "generic",
      url: RECV_URL,
    });
    const res = await post(`/api/webhooks/${created.body.target.id}/test`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].body.alert.rule_type, "test");
  });

  it("clear-data wipes the delivery log but keeps targets", async () => {
    resetReceiver();
    const created = await post("/api/webhooks", { name: "keep", type: "generic", url: RECV_URL });
    await webhooks.dispatchAlert(SAMPLE_ALERT);
    assert.ok(stmts.lastWebhookDeliveryForTarget.get(created.body.target.id));
    await post("/api/settings/clear-data");
    assert.equal(stmts.lastWebhookDeliveryForTarget.get(created.body.target.id), undefined);
    assert.ok(stmts.getWebhookTarget.get(created.body.target.id)); // target survives
  });
});

describe("provider registry", () => {
  it("exposes 14 first-class providers (+ generic = 15 types)", () => {
    const firstClass = [
      "slack",
      "discord",
      "teams",
      "google_chat",
      "mattermost",
      "rocketchat",
      "telegram",
      "pagerduty",
      "opsgenie",
      "splunk_oncall",
      "zapier",
      "make",
      "n8n",
      "pipedream",
    ];
    assert.equal(firstClass.length, 14);
    for (const t of firstClass) {
      assert.ok(providers.WEBHOOK_TYPES.includes(t), `${t} missing`);
    }
    assert.ok(providers.WEBHOOK_TYPES.includes("generic"));
    assert.equal(providers.WEBHOOK_TYPES.length, 15);
  });

  it("GET /api/webhooks/providers returns redacted metadata", async () => {
    const res = await fetchJson("/api/webhooks/providers");
    assert.equal(res.status, 200);
    const pd = res.body.providers.find((p) => p.type === "pagerduty");
    assert.equal(pd.url_required, false); // has default URL
    assert.ok(pd.fields.find((f) => f.key === "routing_key" && f.secret));
    const slack = res.body.providers.find((p) => p.type === "slack");
    assert.equal(slack.url_required, true);
  });
});

describe("provider payload formatting", () => {
  it("mattermost: Slack-style attachments", () => {
    const p = providers.formatPayload("mattermost", SAMPLE_ALERT);
    assert.ok(Array.isArray(p.attachments));
    assert.ok(p.attachments[0].fields.some((f) => f.title === "Type"));
  });

  it("rocketchat: text + attachments", () => {
    const p = providers.formatPayload("rocketchat", SAMPLE_ALERT);
    assert.ok(p.text.includes("Too many errors"));
    assert.ok(Array.isArray(p.attachments));
  });

  it("google_chat: simple text message", () => {
    const p = providers.formatPayload("google_chat", SAMPLE_ALERT);
    assert.ok(typeof p.text === "string" && p.text.includes("Too many errors"));
  });

  it("telegram: sendMessage shape with chat_id + HTML escaping", () => {
    const p = providers.formatPayload(
      "telegram",
      { ...SAMPLE_ALERT, rule_name: "a<b>c" },
      { chat_id: "123" }
    );
    assert.equal(p.chat_id, "123");
    assert.equal(p.parse_mode, "HTML");
    assert.ok(p.text.includes("a&lt;b&gt;c")); // escaped
  });

  it("pagerduty: Events API v2 with routing_key, severity, dedup_key", () => {
    const p = providers.formatPayload("pagerduty", SAMPLE_ALERT, {
      routing_key: "RK",
      severity: "critical",
    });
    assert.equal(p.routing_key, "RK");
    assert.equal(p.event_action, "trigger");
    assert.equal(p.payload.severity, "critical");
    assert.ok(p.dedup_key.includes(SAMPLE_ALERT.rule_id));
  });

  it("opsgenie: message + alias; api_key goes in the GenieKey header, not body", () => {
    const p = providers.formatPayload("opsgenie", SAMPLE_ALERT, { api_key: "KEY" });
    assert.ok(p.message.includes("Too many errors"));
    assert.ok(!JSON.stringify(p).includes("KEY")); // key not in body
    const headers = providers.resolveAuthHeaders({ type: "opsgenie", config: { api_key: "KEY" } });
    assert.equal(headers.Authorization, "GenieKey KEY");
  });

  it("splunk_oncall: VictorOps message_type + entity", () => {
    const p = providers.formatPayload("splunk_oncall", SAMPLE_ALERT, { severity: "CRITICAL" });
    assert.equal(p.message_type, "CRITICAL");
    assert.ok(p.entity_id.includes(SAMPLE_ALERT.rule_id));
  });

  it("generic family (zapier) uses the JSON envelope", () => {
    const p = providers.formatPayload("zapier", SAMPLE_ALERT);
    assert.equal(p.event, "alert.triggered");
  });
});

describe("URL resolution", () => {
  it("telegram derives its URL from the bot token", () => {
    const url = providers.resolveUrl({
      type: "telegram",
      config: { bot_token: "TOK", chat_id: "1" },
    });
    assert.equal(url, "https://api.telegram.org/botTOK/sendMessage");
  });

  it("opsgenie picks the EU host when region=eu", () => {
    assert.ok(
      providers
        .resolveUrl({ type: "opsgenie", config: { region: "eu" } })
        .includes("api.eu.opsgenie.com")
    );
    assert.ok(
      providers
        .resolveUrl({ type: "opsgenie", config: { region: "us" } })
        .includes("api.opsgenie.com")
    );
  });

  it("pagerduty defaults to the Events API URL", () => {
    assert.equal(
      providers.resolveUrl({ type: "pagerduty", config: {} }),
      "https://events.pagerduty.com/v2/enqueue"
    );
  });
});

describe("Splunk On-Call response-body veto", () => {
  it("verifyResponse flags result=failure, trusts everything else", () => {
    const vr = providers.PROVIDERS.splunk_oncall.verifyResponse;
    assert.equal(vr('{"result":"failure","message":"bad routing key"}').ok, false);
    assert.equal(vr('{"result":"success","entity_id":"x"}').ok, true);
    assert.equal(vr("").ok, true); // empty body trusted
    assert.equal(vr("not json").ok, true); // non-JSON 200 trusted
  });

  it("deliver() records a 200-with-result:failure as failed (no retry)", async () => {
    resetReceiver();
    nextStatus = 200;
    nextBody = JSON.stringify({ result: "failure", message: "bad routing key" });
    // Insert directly (splunk is https-only, can't go through the http-mock route).
    const id = "splunk-veto-test";
    stmts.insertWebhookTarget.run(
      id,
      "splunk",
      "splunk_oncall",
      RECV_URL,
      1,
      null,
      null,
      null,
      JSON.stringify({ severity: "WARNING" })
    );
    webhooks.invalidateWebhookCache();
    const target = webhooks.normalizeTarget(stmts.getWebhookTarget.get(id));
    const res = await webhooks.deliver(target, SAMPLE_ALERT);
    assert.equal(res.ok, false);
    assert.match(res.error, /failure|bad routing key/i);
    assert.equal(received.length, 1); // no retry on a logical rejection
    assert.equal(stmts.lastWebhookDeliveryForTarget.get(id).status, "failed");
  });
});

describe("provider CRUD + config redaction", () => {
  it("creates a telegram target without a URL and redacts the bot token", async () => {
    const res = await post("/api/webhooks", {
      name: "tg",
      type: "telegram",
      config: { bot_token: "12345:SECRETTOKEN", chat_id: "999" },
    });
    assert.equal(res.status, 201);
    const t = res.body.target;
    assert.equal(t.config.bot_token, "••••"); // redacted
    assert.equal(t.config.chat_id, "999"); // shown
    assert.ok(!JSON.stringify(t).includes("SECRETTOKEN"));
    assert.ok(t.url_preview.includes("api.telegram.org"));
  });

  it("requires routing_key for pagerduty", async () => {
    const res = await post("/api/webhooks", { name: "pd", type: "pagerduty", config: {} });
    assert.equal(res.status, 400);
  });

  it("rejects an unknown severity enum", async () => {
    const res = await post("/api/webhooks", {
      name: "pd2",
      type: "pagerduty",
      config: { routing_key: "RK", severity: "nope" },
    });
    assert.equal(res.status, 400);
  });

  it("patches opsgenie region without re-sending the api_key", async () => {
    const created = await post("/api/webhooks", {
      name: "og",
      type: "opsgenie",
      config: { api_key: "AAA", region: "us" },
    });
    const id = created.body.target.id;
    const res = await patch(`/api/webhooks/${id}`, { config: { region: "eu" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.target.config.region, "eu");
    assert.equal(
      stmts.getWebhookTarget.get(id) && JSON.parse(stmts.getWebhookTarget.get(id).config).api_key,
      "AAA"
    );
  });

  // pagerduty/opsgenie endpoints are https-only and (opsgenie) derive their own
  // URL, so they can't point at the http test mock - assert the built request
  // (URL + headers + body) directly instead.
  it("buildRequest: pagerduty hits the Events API with the routing key in the body", () => {
    const req = webhooks.buildRequest(
      { type: "pagerduty", config: { routing_key: "RK123", severity: "error" } },
      SAMPLE_ALERT
    );
    assert.equal(req.url, "https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(req.body);
    assert.equal(body.routing_key, "RK123");
    assert.equal(body.payload.severity, "error");
  });

  it("buildRequest: opsgenie targets the region host and sets the GenieKey header", () => {
    const req = webhooks.buildRequest(
      { type: "opsgenie", config: { api_key: "KEY9", region: "eu" } },
      SAMPLE_ALERT
    );
    assert.ok(req.url.includes("api.eu.opsgenie.com"));
    assert.equal(req.headers.Authorization, "GenieKey KEY9");
    assert.ok(!req.body.includes("KEY9")); // key only in the header
  });
});
