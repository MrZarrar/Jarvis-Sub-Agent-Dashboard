/**
 * @file Supplementary OpenAPI 3.0 fragments for the Today board routes mounted
 * at `/api/today` (see server/routes/today.js). Exports `{ tags, schemas,
 * paths }` merged into the base spec by `createOpenApiSpec()`.
 * @author Jarvis (Phase AC)
 */

const tags = [
  {
    name: "Today",
    description:
      "Daily todo board: open note todos, Monday items due/overdue, today's scheduled prompts, waiting agents, and today's runs - aggregated server-side with no new storage.",
  },
];

const schemas = {
  TodayBoard: {
    type: "object",
    properties: {
      date: { type: "string", example: "2026-07-10" },
      todos: {
        type: "array",
        description: "Open `- [ ]` todos across notes, with note id + body line ref.",
        items: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            noteTitle: { type: "string" },
            line: { type: "integer", description: "0-based line index within the note body." },
            text: { type: "string" },
          },
        },
      },
      monday: {
        type: "object",
        properties: {
          configured: { type: "boolean" },
          dueToday: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
          overdue: { type: "array", items: { $ref: "#/components/schemas/MondayItem" } },
        },
      },
      schedules: {
        type: "object",
        properties: {
          pending: { type: "array", items: { type: "object" } },
          firedToday: { type: "array", items: { type: "object" } },
        },
      },
      agents: {
        type: "object",
        properties: {
          waiting: { type: "array", items: { type: "object" } },
          workingCount: { type: "integer" },
        },
      },
      runs: {
        type: "object",
        properties: {
          running: { type: "array", items: { type: "object" } },
          completedToday: { type: "array", items: { type: "object" } },
          failedToday: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
};

const paths = {
  "/api/today": {
    get: {
      tags: ["Today"],
      operationId: "getTodayBoard",
      summary: "The aggregated Today board (computed per request, no storage)",
      responses: {
        200: {
          description: "Board snapshot.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/TodayBoard" } },
          },
        },
      },
    },
  },
  "/api/today/todos/check": {
    post: {
      tags: ["Today"],
      operationId: "checkTodayTodo",
      summary: "Check/uncheck one note todo (rewrites the `- [ ]` line in the markdown file)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["noteId", "text"],
              properties: {
                noteId: { type: "string" },
                line: { type: "integer", description: "Body line ref from GET /api/today." },
                text: { type: "string", description: "The todo text (re-finds a moved line)." },
                checked: { type: "boolean", default: true },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Rewritten; `line` is the line actually changed." },
        400: { description: "noteId and text are required." },
        404: { description: "Note or todo not found (the note changed)." },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
