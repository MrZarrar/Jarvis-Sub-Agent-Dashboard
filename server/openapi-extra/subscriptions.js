/**
 * @file Supplementary OpenAPI 3.0 fragments for the subscriptions / finance
 * tracker (Phase AE), mounted at `/api/subscriptions` (see
 * server/routes/subscriptions.js). Exports `{ tags, schemas, paths }` merged
 * into the base spec by `createOpenApiSpec()`.
 * @author Jarvis (Phase AE)
 */

const tags = [
  {
    name: "Subscriptions",
    description:
      "Manual subscriptions / finance tracker: CRUD, a per-currency monthly-burn summary, and a paste-to-parse brain assist. No bank integrations by design.",
  },
];

const schemas = {
  Subscription: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string", example: "GBP" },
      cadence: { type: "string", enum: ["monthly", "yearly", "custom"] },
      cadence_days: {
        type: "integer",
        nullable: true,
        description: "Renewal interval in days; only used when cadence is 'custom'.",
      },
      next_renewal: {
        type: "string",
        nullable: true,
        example: "2026-08-01",
        description: "Next renewal date (YYYY-MM-DD); the server rolls past dates forward.",
      },
      category: { type: "string", nullable: true },
      notes: { type: "string", nullable: true },
      active: { type: "integer", enum: [0, 1] },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  SubscriptionSummary: {
    type: "object",
    properties: {
      active_count: { type: "integer" },
      by_currency: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            monthly_burn: { type: "number" },
            yearly_projection: { type: "number" },
            count: { type: "integer" },
          },
        },
        description: "Per-currency rollup - mixed currencies are never converted.",
      },
      upcoming: {
        type: "array",
        items: { $ref: "#/components/schemas/Subscription" },
        description: "Active subscriptions renewing within 7 days (with days_until).",
      },
      next_renewal: {
        type: "object",
        nullable: true,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          date: { type: "string" },
          days_until: { type: "integer" },
        },
      },
    },
  },
  SubscriptionCandidate: {
    type: "object",
    properties: {
      name: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string" },
      cadence: { type: "string", enum: ["monthly", "yearly", "custom"] },
      cadence_days: { type: "integer", nullable: true },
      category: { type: "string", nullable: true },
    },
  },
};

const paths = {
  "/api/subscriptions": {
    get: {
      tags: ["Subscriptions"],
      operationId: "listSubscriptions",
      summary: "List all subscriptions (active first, soonest renewal first)",
      responses: {
        200: {
          description: "Subscription list.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  subscriptions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Subscription" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Subscriptions"],
      operationId: "createSubscription",
      summary: "Create a subscription (next_renewal defaults to one cadence from today)",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
        },
      },
      responses: {
        201: {
          description: "Created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { subscription: { $ref: "#/components/schemas/Subscription" } },
              },
            },
          },
        },
        400: { description: "Validation error." },
      },
    },
  },
  "/api/subscriptions/summary": {
    get: {
      tags: ["Subscriptions"],
      operationId: "getSubscriptionSummary",
      summary: "Per-currency monthly burn, yearly projection, and upcoming renewals",
      responses: {
        200: {
          description: "Summary rollup.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/SubscriptionSummary" } },
          },
        },
      },
    },
  },
  "/api/subscriptions/parse": {
    post: {
      tags: ["Subscriptions"],
      operationId: "parseSubscriptions",
      summary: "Extract candidate subscriptions from pasted text (nothing is saved)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Candidates for confirm-before-save. formatted=false means the deterministic heuristic (no brain provider) produced them.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  candidates: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SubscriptionCandidate" },
                  },
                  formatted: { type: "boolean" },
                  provider: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        400: { description: "text is required." },
      },
    },
  },
  "/api/subscriptions/{id}": {
    put: {
      tags: ["Subscriptions"],
      operationId: "updateSubscription",
      summary: "Update a subscription (partial patch)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
        },
      },
      responses: {
        200: { description: "Updated." },
        400: { description: "Validation error." },
        404: { description: "Not found." },
      },
    },
    delete: {
      tags: ["Subscriptions"],
      operationId: "deleteSubscription",
      summary: "Delete a subscription",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Deleted." },
        404: { description: "Not found." },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
