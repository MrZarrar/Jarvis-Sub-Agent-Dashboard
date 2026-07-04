/**
 * @file OpenAPI 3.0 fragment for the multi-provider Chat feature (Phase E,
 * `server/routes/chat.js`, mounted at `/api/chat`). Provider adapters live in
 * `server/lib/providers/`. First-party web UI only - every route sits behind the
 * Run router's loopback same-origin guard. Provider secrets are never returned:
 * `GET /config` is redacted to `hasApiKey` booleans.
 *
 * Merged into the base spec by `server/openapi-extra.js`. Exports exactly
 * `{ tags, schemas, paths }`; the shared `ErrorResponse` envelope is referenced,
 * never redefined.
 *
 * @author Jarvis (Phase E)
 */

const tags = [
  {
    name: "Chat",
    description:
      "Multi-provider AI chat (Gemini / Ollama / Claude; inert GPT slot). Streaming completions over Server-Sent Events; secrets stay server-side.",
  },
];

const schemas = {
  ChatMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      chat_id: { type: "string" },
      role: { type: "string", enum: ["user", "assistant", "system"] },
      provider: { type: "string", nullable: true },
      model: { type: "string", nullable: true },
      content: { type: "string" },
      image_path: { type: "string", nullable: true },
      created_at: { type: "string" },
    },
  },
  Chat: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", nullable: true },
      provider: { type: "string", nullable: true },
      model: { type: "string", nullable: true },
      cc_session_id: { type: "string", nullable: true },
      created_at: { type: "string" },
      updated_at: { type: "string" },
    },
  },
};

const paths = {
  "/api/chat/providers": {
    get: {
      tags: ["Chat"],
      summary: "List chat providers + live models",
      description:
        "Every provider with its configured/available state, capabilities, and model list (Ollama models are discovered live from its host). Includes the inert GPT slot (`disabled: true`, `note`).",
      operationId: "chatProviders",
      responses: { 200: { description: "Provider list" } },
    },
  },
  "/api/chat/config": {
    get: {
      tags: ["Chat"],
      summary: "Redacted provider config",
      description: "Provider keys/hosts with secrets replaced by `hasApiKey` booleans.",
      operationId: "chatGetConfig",
      responses: { 200: { description: "Redacted config" } },
    },
    put: {
      tags: ["Chat"],
      summary: "Update provider config",
      description:
        "Partial patch of provider keys/hosts/models (whitelisted fields only). Persisted to the gitignored server/config/providers.json. Returns the redacted config.",
      operationId: "chatPutConfig",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: { 200: { description: "Redacted config after update" } },
    },
  },
  "/api/chat/chats": {
    get: {
      tags: ["Chat"],
      summary: "List conversations",
      operationId: "chatListChats",
      responses: { 200: { description: "Conversations" } },
    },
    post: {
      tags: ["Chat"],
      summary: "Create a conversation",
      operationId: "chatCreateChat",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                provider: { type: "string" },
                model: { type: "string" },
              },
            },
          },
        },
      },
      responses: { 201: { description: "Created conversation" } },
    },
  },
  "/api/chat/chats/{id}": {
    get: {
      tags: ["Chat"],
      summary: "Get a conversation with messages",
      operationId: "chatGetChat",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Conversation + messages" },
        404: { description: "Not found" },
      },
    },
    patch: {
      tags: ["Chat"],
      summary: "Rename a conversation",
      operationId: "chatRenameChat",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
            },
          },
        },
      },
      responses: { 200: { description: "Renamed" }, 404: { description: "Not found" } },
    },
    delete: {
      tags: ["Chat"],
      summary: "Delete a conversation",
      operationId: "chatDeleteChat",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Deleted" }, 404: { description: "Not found" } },
    },
  },
  "/api/chat/chats/{id}/messages": {
    post: {
      tags: ["Chat"],
      summary: "Send a turn (Server-Sent Events)",
      description:
        "Persists the user turn and streams the assistant reply as SSE: `event: user` → repeated `event: delta` ({ text }) → `event: done` ({ message }) or `event: error`. NOT a JSON response - the content type is text/event-stream.",
      operationId: "chatSendMessage",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["text"],
              properties: {
                text: { type: "string" },
                provider: { type: "string" },
                model: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "SSE stream (text/event-stream)" },
        400: {
          description: "Bad input / unknown provider",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
          },
        },
        404: { description: "Chat not found" },
      },
    },
  },
  "/api/chat/chats/{id}/image": {
    post: {
      tags: ["Chat"],
      summary: "Generate an image (Gemini)",
      operationId: "chatGenerateImage",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["prompt"],
              properties: { prompt: { type: "string" }, model: { type: "string" } },
            },
          },
        },
      },
      responses: {
        201: { description: "Assistant image message + url" },
        400: { description: "Bad input / provider without image support" },
        502: { description: "Image provider error" },
      },
    },
  },
  "/api/chat/images/{file}": {
    get: {
      tags: ["Chat"],
      summary: "Serve a generated image",
      description: "Strict filename validation prevents path traversal.",
      operationId: "chatServeImage",
      parameters: [{ name: "file", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Image bytes" }, 404: { description: "Not found" } },
    },
  },
};

module.exports = { tags, schemas, paths };
