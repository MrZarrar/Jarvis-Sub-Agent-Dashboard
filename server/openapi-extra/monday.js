/**
 * @file Supplementary OpenAPI 3.0 fragments for the Monday.com panel routes
 * mounted at `/api/monday` (see server/routes/monday.js). Exports
 * `{ tags, schemas, paths }` merged into the base spec by `createOpenApiSpec()`.
 * Schemas are prefixed `Monday` to avoid collisions.
 * @author Jarvis (Phase AD)
 */

const tags = [
  {
    name: "Monday",
    description:
      "Monday.com panel: my items grouped by board, due/overdue today, and recent updates, via a server-side personal API token (GraphQL). Write-back is limited to marking an item done.",
  },
];

const schemas = {
  MondayItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      boardId: { type: "string" },
      boardName: { type: "string" },
      group: { type: "string", nullable: true },
      name: { type: "string" },
      url: { type: "string", format: "uri", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
      dueDate: { type: "string", nullable: true, example: "2026-07-10" },
      status: { type: "string", nullable: true },
      statusColumnId: { type: "string", nullable: true },
      mine: { type: "boolean" },
      done: { type: "boolean" },
    },
  },
  MondayOverview: {
    type: "object",
    properties: {
      configured: { type: "boolean" },
      me: {
        type: "object",
        nullable: true,
        properties: { id: { type: "string" }, name: { type: "string", nullable: true } },
      },
      boards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            url: { type: "string", nullable: true },
            itemCount: { type: "integer" },
          },
        },
      },
      mine: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
      dueToday: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
      overdue: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
      recent: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
      counts: {
        type: "object",
        properties: {
          mine: { type: "integer" },
          dueToday: { type: "integer" },
          overdue: { type: "integer" },
          boards: { type: "integer" },
        },
      },
      error: { type: "string", nullable: true },
    },
  },
  MondayConfig: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      hasToken: { type: "boolean", description: "The token itself is never returned." },
      pollMinutes: { type: "integer" },
      doneLabel: { type: "string", example: "Done" },
    },
  },
};

const overviewResponse = {
  description: "Overview snapshot.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          overview: { $ref: "#/components/schemas/MondayOverview" },
          fetchedAt: { type: "string", format: "date-time", nullable: true },
          error: { type: "string", nullable: true },
          configured: { type: "boolean" },
        },
      },
    },
  },
};

const paths = {
  "/api/monday": {
    get: {
      tags: ["Monday"],
      operationId: "getMondayOverview",
      summary: "Cached Monday overview (served from SQLite, instant)",
      responses: { 200: overviewResponse },
    },
  },
  "/api/monday/refresh": {
    post: {
      tags: ["Monday"],
      operationId: "refreshMonday",
      summary: "Force a fresh poll of the Monday API now",
      responses: { 200: overviewResponse },
    },
  },
  "/api/monday/config": {
    get: {
      tags: ["Monday"],
      operationId: "getMondayConfig",
      summary: "Redacted Monday config (hasToken, pollMinutes, doneLabel)",
      responses: {
        200: {
          description: "Redacted config.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { config: { $ref: "#/components/schemas/MondayConfig" } },
              },
            },
          },
        },
      },
    },
    put: {
      tags: ["Monday"],
      operationId: "updateMondayConfig",
      summary: "Update Monday config (token stays server-side, never echoed back)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                token: { type: "string" },
                pollMinutes: { type: "integer" },
                doneLabel: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Updated (redacted view)." },
        400: { description: "Validation error." },
      },
    },
  },
  "/api/monday/items/{id}/done": {
    post: {
      tags: ["Monday"],
      operationId: "markMondayItemDone",
      summary: "Set an item's status column to the configured done label",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { type: "object", properties: { boardId: { type: "string" } } },
          },
        },
      },
      responses: {
        200: { description: "Marked done; the response includes the refreshed overview." },
        404: { description: "Item not found in the cached overview." },
        502: { description: "The Monday API rejected the mutation." },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
