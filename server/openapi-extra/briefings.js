/**
 * @file Supplementary OpenAPI 3.0 fragments for proactive Jarvis - briefings,
 * nudges & the persona toggle - mounted at `/api/briefings` (see
 * server/routes/briefings.js). Exports `{ tags, schemas, paths }` merged into the
 * base spec by `createOpenApiSpec()`. Error responses reuse the base
 * `MessageErrorResponse` shape (`{ error: { code, message } }`).
 * @author Jarvis (Phase J)
 */

const tags = [
  {
    name: "Briefings",
    description:
      "Proactive Jarvis: morning/evening briefings composed from project pulse + GitHub + run activity, deterministic nudges, and the JARVIS personality toggle.",
  },
];

const schemas = {
  Briefing: {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["morning", "evening"] },
      trigger: {
        type: "string",
        nullable: true,
        enum: ["schedule", "manual", "voice"],
        description: "What produced this briefing.",
      },
      text: { type: "string", description: "Full briefing markdown." },
      speech: {
        type: "string",
        nullable: true,
        description: "Short, markdown-free, Siri-readable variant.",
      },
      provider: {
        type: "string",
        nullable: true,
        description:
          "Brain provider that composed the prose, or null for the deterministic fallback.",
      },
      note_id: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
    },
  },
  BriefingScheduleConfig: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      time: { type: "string", example: "07:00", description: "HH:MM 24h local time." },
    },
  },
  NudgesConfig: {
    type: "object",
    properties: {
      runFailed: { type: "boolean" },
      waitingAgents: { type: "boolean" },
      waitingMinutes: { type: "integer", minimum: 1, maximum: 240 },
    },
  },
  ProactiveConfig: {
    type: "object",
    properties: {
      morning: { $ref: "#/components/schemas/BriefingScheduleConfig" },
      evening: { $ref: "#/components/schemas/BriefingScheduleConfig" },
      nudges: { $ref: "#/components/schemas/NudgesConfig" },
      persona: { type: "boolean", description: "JARVIS personality toggle." },
    },
  },
};

const paths = {
  "/api/briefings": {
    get: {
      tags: ["Briefings"],
      summary: "Recent briefings + latest per kind",
      operationId: "listBriefings",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", default: 30 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
      ],
      responses: {
        200: {
          description: "Briefing history and the latest of each kind.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/Briefing" } },
                  latest: {
                    type: "object",
                    properties: {
                      morning: { $ref: "#/components/schemas/Briefing", nullable: true },
                      evening: { $ref: "#/components/schemas/Briefing", nullable: true },
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
  "/api/briefings/run": {
    post: {
      tags: ["Briefings"],
      summary: "Compose + persist + push a briefing now",
      operationId: "runBriefing",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { kind: { type: "string", enum: ["morning", "evening"] } },
            },
          },
        },
      },
      responses: {
        201: {
          description: "The composed briefing.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { briefing: { $ref: "#/components/schemas/Briefing" } },
              },
            },
          },
        },
        500: {
          description: "Composition failed.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MessageErrorResponse" } },
          },
        },
      },
    },
  },
  "/api/briefings/config": {
    get: {
      tags: ["Briefings"],
      summary: "Combined Phase-J config (times, nudges, persona)",
      operationId: "getBriefingsConfig",
      responses: {
        200: {
          description: "The resolved config.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { config: { $ref: "#/components/schemas/ProactiveConfig" } },
              },
            },
          },
        },
      },
    },
    put: {
      tags: ["Briefings"],
      summary: "Patch briefing times, nudge rules, and/or the persona toggle",
      operationId: "updateBriefingsConfig",
      requestBody: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ProactiveConfig" } },
        },
      },
      responses: {
        200: {
          description: "The updated config.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { config: { $ref: "#/components/schemas/ProactiveConfig" } },
              },
            },
          },
        },
        400: {
          description: "Invalid config.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MessageErrorResponse" } },
          },
        },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
