/**
 * @file Supplementary OpenAPI 3.0 fragments for the dormant business
 * integrations mounted at `/api/business` (server/routes/business.js) and the
 * Codex usage summary at `/api/analytics/codex` (Phase AB1). Exports
 * `{ tags, schemas, paths }` merged into the base spec by `createOpenApiSpec()`.
 * @author Jarvis (Phase BM / AB1)
 */

const NOT_CONNECTED = {
  description:
    "Integration is dormant (disabled or missing credentials). Enable it under Settings → Business integrations.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/MessageErrorResponse" },
      example: {
        error: {
          code: "NOT_CONNECTED",
          message:
            "keepa integration is not connected - enable it and save credentials in Settings → Business integrations",
        },
      },
    },
  },
};

const tags = [
  {
    name: "Business",
    description:
      "Dormant-by-design business integrations (Phase BM): eBay (Browse comps + unpublished draft listings), Amazon SP-API (catalog/offers), Keepa (UK price/rank stats), SellerAmp (deep-links only). Operational endpoints answer 503 NOT_CONNECTED until enabled + credentialed in Settings.",
  },
];

const schemas = {
  BusinessProviderView: {
    type: "object",
    description:
      "Client-safe provider config: secrets are redacted to has* booleans; `connected` = enabled AND credentialed.",
    properties: {
      enabled: { type: "boolean" },
      hasCreds: { type: "boolean" },
      connected: { type: "boolean" },
    },
    additionalProperties: true,
  },
};

const paths = {
  "/api/business/integrations": {
    get: {
      tags: ["Business"],
      operationId: "getBusinessIntegrations",
      summary: "Redacted status of every business integration",
      responses: {
        200: {
          description: "Per-provider redacted config + readiness flags",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "object",
                    additionalProperties: {
                      $ref: "#/components/schemas/BusinessProviderView",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/business/integrations/{provider}": {
    put: {
      tags: ["Business"],
      operationId: "updateBusinessIntegration",
      summary: "Save a credential/config patch for one provider (ebay|amazon|keepa|selleramp)",
      parameters: [
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        200: { description: "New redacted view" },
        400: { description: "Unknown provider / bad patch" },
      },
    },
  },
  "/api/business/integrations/{provider}/test": {
    post: {
      tags: ["Business"],
      operationId: "testBusinessIntegration",
      summary: "Fire one cheap real credential check (token fetch / quota read)",
      parameters: [
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: { description: "Credentials verified" },
        502: { description: "Upstream rejected the credentials" },
        503: NOT_CONNECTED,
      },
    },
  },
  "/api/business/keepa/{asin}": {
    get: {
      tags: ["Business"],
      operationId: "getKeepaProduct",
      summary: "90-day Keepa stats for one ASIN (UK domain; prices mapped pence → GBP)",
      parameters: [{ name: "asin", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Trimmed stats" }, 502: { description: "Upstream error" }, 503: NOT_CONNECTED },
    },
  },
  "/api/business/amazon/{asin}": {
    get: {
      tags: ["Business"],
      operationId: "getAmazonProduct",
      summary: "SP-API catalog summary + current New offers for one ASIN (amazon.co.uk)",
      parameters: [{ name: "asin", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Catalog + offers" }, 502: { description: "Upstream error" }, 503: NOT_CONNECTED },
    },
  },
  "/api/business/ebay/search": {
    get: {
      tags: ["Business"],
      operationId: "ebaySearch",
      summary: "eBay Browse comps (ACTIVE listings / asking prices - not sold comps)",
      parameters: [
        { name: "q", in: "query", required: true, schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 50 } },
      ],
      responses: { 200: { description: "Item summaries" }, 400: { description: "q missing" }, 502: { description: "Upstream error" }, 503: NOT_CONNECTED },
    },
  },
  "/api/business/ebay/listing": {
    post: {
      tags: ["Business"],
      operationId: "ebayCreateDraftListing",
      summary:
        "Create an UNPUBLISHED eBay draft (inventory item + offer). Publishing stays a human step in Seller Hub - this endpoint never publishes.",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["sku", "title", "price"],
              properties: {
                sku: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                price: { type: "number" },
                quantity: { type: "integer", default: 1 },
                condition: { type: "string", default: "USED_EXCELLENT" },
                imageUrls: { type: "array", items: { type: "string", format: "uri" } },
              },
            },
          },
        },
      },
      responses: { 200: { description: "Draft created (published: false)" }, 502: { description: "Upstream error" }, 503: NOT_CONNECTED },
    },
  },
  "/api/business/selleramp/link": {
    get: {
      tags: ["Business"],
      operationId: "sellerampLink",
      summary: "SellerAmp SAS lookup deep-link (no API, no credentials - always available)",
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "{ url }" }, 400: { description: "q missing" } },
    },
  },
  "/api/analytics/codex": {
    get: {
      tags: ["Analytics"],
      operationId: "getCodexUsage",
      summary:
        "Codex usage summary (Phase AB1): token totals aggregated from ingested ~/.codex/sessions rollouts.",
      responses: {
        200: {
          description: "Usage summary",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  configured: { type: "boolean" },
                  sessions: { type: "integer" },
                  active: { type: "integer" },
                  tokens: {
                    type: "object",
                    properties: {
                      input: { type: "integer" },
                      cachedInput: { type: "integer" },
                      output: { type: "integer" },
                      total: { type: "integer" },
                    },
                  },
                  byDay: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { date: { type: "string" }, total: { type: "integer" } },
                    },
                  },
                  lastActivity: { type: "string", nullable: true },
                  limitWindow: { type: "string", example: "unknown" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/analytics/codex/limits": {
    get: {
      tags: ["Analytics"],
      operationId: "getCodexRateLimits",
      summary: "Live Codex subscription 5-hour and weekly allowance from the local app-server",
      responses: { 200: { description: "Native Codex rate-limit windows" }, 503: { description: "Codex app-server unavailable" } },
    },
  },
};

module.exports = { tags, schemas, paths };
