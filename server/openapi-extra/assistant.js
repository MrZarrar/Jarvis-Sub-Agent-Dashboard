/**
 * @file Supplementary OpenAPI 3.0 fragments for the voice/assistant routes
 * mounted at `/api/assistant` (Phase D — see server/routes/assistant.js,
 * server/lib/assistant.js, server/lib/assistant-token.js, and server/lib/brain).
 * Exports `{ tags, schemas, paths }` for merging into the base spec by
 * `createOpenApiSpec()` via server/openapi-extra.js. Schemas are prefixed
 * `Assistant` to avoid collisions. Error responses reuse the base
 * `ErrorResponse` schema (`{ error: { code, message } }`).
 * @author Jarvis (Phase D)
 */

const tags = [
  {
    name: "Assistant",
    description:
      "Voice/assistant surface (Phase D). One public endpoint — POST /api/assistant/ask — powers Siri Shortcuts, CarPlay, the notes chat, and quick actions, returning { text, speech }. Authenticated with scoped, revocable bearer tokens generated in Settings → Voice (managed via /api/assistant/tokens).",
  },
];

const schemas = {
  AssistantAskRequest: {
    type: "object",
    required: ["text"],
    description:
      "A natural-language utterance. A deterministic keyword prelude handles high-value intents (status / kill / steer / note: / run skill) before falling through to the mini-Jarvis brain.",
    properties: {
      text: {
        type: "string",
        description: "The user's dictated or typed request.",
        example: "status",
      },
      source: {
        type: "string",
        enum: ["siri", "carplay", "chat", "notes", "quickaction"],
        description:
          "Where the request originated (defaults to `chat`). Recorded on captured notes.",
        example: "siri",
      },
      conversationId: {
        type: "string",
        description:
          "Optional opaque id (≤128 chars) threading a multi-turn conversation. Turns are kept in a bounded in-memory buffer so context survives within a session.",
        example: "car-2026-07-04",
      },
      speak: {
        type: "boolean",
        description:
          "Hint that the caller will read `speech` aloud. Advisory only — `speech` is always returned.",
        example: true,
      },
    },
  },

  AssistantAskResponse: {
    type: "object",
    required: ["text", "speech", "intent", "source"],
    description:
      "The assistant reply. `text` is the full answer; `speech` is a short (~2 sentence), markdown-free, number-rounded variant for text-to-speech.",
    properties: {
      text: {
        type: "string",
        description: "Full answer text.",
        example:
          "2 dashboard runs live, 1 waiting on a permission decision. 3 active sessions, 1 agent working, 0 waiting on you.",
      },
      speech: {
        type: "string",
        description: "Short spoken-style variant Siri reads aloud (no markdown, rounded numbers).",
        example: "2 runs live, 3 active sessions, 1 waiting on a decision.",
      },
      intent: {
        type: "string",
        enum: ["status", "kill", "steer", "note", "run_skill", "chat", "empty"],
        description:
          "Which deterministic intent handled the request (`chat` = fell through to the brain).",
        example: "status",
      },
      source: { type: "string", example: "siri" },
      conversationId: {
        type: "string",
        nullable: true,
        description: "Echoed conversation id, or null.",
        example: "car-2026-07-04",
      },
      provider: {
        type: "string",
        description:
          "Present for `chat` intent. `stub` until the Phase G brain wires in real providers.",
        example: "stub",
      },
      taskClass: {
        type: "string",
        enum: ["simple", "standard", "complex"],
        description: "Present for `chat` intent — the brain's task-tier classification.",
        example: "simple",
      },
      data: {
        type: "object",
        additionalProperties: true,
        description:
          "Optional structured detail for the intent (e.g. status counts, killed run ids).",
      },
    },
  },

  AssistantToken: {
    type: "object",
    required: ["id", "prefix", "createdAt"],
    description:
      "A stored assistant token, WITHOUT its secret (only a hash is persisted server-side).",
    properties: {
      id: { type: "string", example: "0d1c3f2a-8b4e-4c1a-9f2d-7e6a5b4c3d2e" },
      prefix: {
        type: "string",
        description: "First few characters of the token, for recognition in the UI.",
        example: "aB3xYz",
      },
      label: { type: "string", nullable: true, example: "iPhone Siri" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: "string", format: "date-time", nullable: true },
    },
  },

  AssistantTokenListResponse: {
    type: "object",
    required: ["tokens"],
    properties: {
      tokens: { type: "array", items: { $ref: "#/components/schemas/AssistantToken" } },
    },
  },

  AssistantTokenCreateRequest: {
    type: "object",
    description: "Optional label for the new token (e.g. the device that will store it).",
    properties: {
      label: { type: "string", example: "iPhone Siri" },
    },
  },

  AssistantTokenCreateResponse: {
    type: "object",
    required: ["token"],
    description:
      "The freshly created token. `token.token` (the plaintext secret) is present EXACTLY ONCE, here — store it in the Shortcut now; it is never retrievable again.",
    properties: {
      token: {
        allOf: [
          { $ref: "#/components/schemas/AssistantToken" },
          {
            type: "object",
            required: ["token"],
            properties: {
              token: {
                type: "string",
                description: "The plaintext bearer token (shown only at creation).",
                example: "aB3xYz9_kQ2m...redacted",
              },
            },
          },
        ],
      },
    },
  },
};

const paths = {
  "/api/assistant/ask": {
    post: {
      tags: ["Assistant"],
      summary: "Ask Jarvis (voice/chat)",
      description:
        "The single endpoint that powers Siri Shortcuts, CarPlay, the notes chat, and quick actions. Returns `{ text, speech }` (plus `intent` and optional `data`). A deterministic keyword prelude handles status / kill / steer / `note:` / `run skill` before the request reaches the (stubbed) mini-Jarvis brain.\n\n**Auth:** requires a scoped assistant bearer token (`Authorization: Bearer <token>` or `x-assistant-token`), generated in Settings → Voice. This route is exempt from the generic DASHBOARD_TOKEN gate so a Shortcut carries ONLY the assistant token — but it is never open: a request with no browser Origin MUST present a valid token. The dashboard's own first-party web UI (loopback/allowlisted Origin) may call it without a token, still subject to DASHBOARD_TOKEN when configured. Rate limited per token (default 60/min).",
      operationId: "assistantAsk",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AssistantAskRequest" },
            example: { text: "status", source: "siri" },
          },
        },
      },
      responses: {
        200: {
          description: "The assistant reply",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssistantAskResponse" },
              example: {
                text: "2 dashboard runs live. 3 active sessions, 1 agent working, 0 waiting on you.",
                speech: "2 runs live, 3 active sessions.",
                intent: "status",
                source: "siri",
                conversationId: null,
                data: { liveRuns: 2, activeSessions: 3, workingAgents: 1, waitingAgents: 0 },
              },
            },
          },
        },
        400: {
          description: "`text` was missing or empty",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: { error: { code: "EBADINPUT", message: "text is required" } },
            },
          },
        },
        401: {
          description:
            "Missing or invalid assistant token (or dashboard token for first-party calls)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: {
                error: {
                  code: "EUNAUTHORIZED",
                  message: "assistant token required — generate one in Settings → Voice",
                },
              },
            },
          },
        },
        429: {
          description: "Rate limit exceeded (see the `Retry-After` header)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: {
                error: { code: "ERATELIMIT", message: "rate limit exceeded — retry in 42s" },
              },
            },
          },
        },
      },
    },
  },

  "/api/assistant/tokens": {
    get: {
      tags: ["Assistant"],
      summary: "List assistant tokens",
      description:
        "Returns all stored assistant tokens WITHOUT their secrets (only a hash is persisted). Behind the dashboard token gate + a loopback same-origin guard — a web-UI-only admin route.",
      operationId: "assistantListTokens",
      responses: {
        200: {
          description: "The stored tokens",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssistantTokenListResponse" },
            },
          },
        },
      },
    },
    post: {
      tags: ["Assistant"],
      summary: "Generate an assistant token",
      description:
        "Creates a new scoped bearer token. The plaintext secret is returned EXACTLY ONCE in `token.token` — store it in your Shortcut immediately; only its hash is persisted, so it is never retrievable again. Behind the dashboard token gate + a loopback same-origin guard.",
      operationId: "assistantCreateToken",
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AssistantTokenCreateRequest" },
            example: { label: "iPhone Siri" },
          },
        },
      },
      responses: {
        201: {
          description: "Token created (secret shown once)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssistantTokenCreateResponse" },
            },
          },
        },
      },
    },
  },

  "/api/assistant/tokens/{id}": {
    delete: {
      tags: ["Assistant"],
      summary: "Revoke an assistant token",
      description:
        "Deletes (revokes) a token by id so it can no longer authenticate. Behind the dashboard token gate + a loopback same-origin guard.",
      operationId: "assistantRevokeToken",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The token id to revoke.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Token revoked",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", enum: [true], example: true } },
              },
            },
          },
        },
        404: {
          description: "No token with that id",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: { error: { code: "ENOTFOUND", message: "token not found" } },
            },
          },
        },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
