const tags = [
  { name: "Missions", description: "Provider-neutral Agentic OS lifecycle and timeline." },
  {
    name: "Provider capabilities",
    description: "Availability, models, controls, and billing boundaries.",
  },
  { name: "Codex Remote", description: "Supported native Remote lifecycle and pairing handoff." },
];

const schemas = {
  Mission: {
    type: "object",
    required: ["id", "title", "domain", "status", "owner_provider", "owner_model_tier"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      domain: { type: "string", enum: ["personal", "development", "business", "generic"] },
      interaction: { type: "string" },
      status: {
        type: "string",
        enum: [
          "queued",
          "planning",
          "delegated",
          "running",
          "waiting_approval",
          "blocked",
          "completed",
          "failed",
          "cancelled",
        ],
      },
      owner_provider: { type: "string" },
      worker_provider: { type: "string", nullable: true },
      owner_model_tier: { type: "string", enum: ["fast", "standard", "executor", "deep_review"] },
      native_thread_id: { type: "string", nullable: true },
      routing_reason: { type: "string" },
      controls: { type: "object", additionalProperties: { type: "boolean" } },
    },
    additionalProperties: true,
  },
  MissionCreate: {
    type: "object",
    required: ["prompt", "domain"],
    properties: {
      title: { type: "string" },
      prompt: { type: "string" },
      domain: { type: "string", enum: ["personal", "development", "business", "generic"] },
      interaction: { type: "string" },
      modelTier: { type: "string", enum: ["fast", "standard", "executor", "deep_review"] },
      workspace: { type: "string" },
      assignments: {
        type: "array",
        maxItems: 4,
        items: { type: "object", required: ["prompt", "domain"], additionalProperties: true },
      },
    },
  },
};

const missionResponse = {
  description: "Mission",
  content: {
    "application/json": {
      schema: { type: "object", properties: { mission: { $ref: "#/components/schemas/Mission" } } },
    },
  },
};
const id = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];

const paths = {
  "/api/missions": {
    get: {
      tags: ["Missions"],
      operationId: "listMissions",
      responses: { 200: { description: "Mission list" } },
    },
    post: {
      tags: ["Missions"],
      operationId: "createMission",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCreate" } } },
      },
      responses: {
        201: missionResponse,
        400: { description: "Policy, provider, or validation error" },
      },
    },
  },
  "/api/missions/{id}": {
    get: {
      tags: ["Missions"],
      operationId: "getMission",
      parameters: id,
      responses: {
        200: { description: "Mission, events, approvals, and children" },
        404: { description: "Not found" },
      },
    },
  },
  "/api/missions/metrics": {
    get: {
      tags: ["Missions"],
      operationId: "getMissionMetrics",
      responses: {
        200: {
          description:
            "Measured success, escalation, fan-out, latency, provider/model, and schedule reliability counters",
        },
      },
    },
  },
  "/api/missions/{id}/events": {
    get: {
      tags: ["Missions"],
      operationId: "getMissionEvents",
      parameters: id,
      responses: { 200: { description: "Normalized, redacted timeline" } },
    },
  },
  "/api/missions/{id}/steer": {
    post: {
      tags: ["Missions"],
      operationId: "steerMission",
      parameters: id,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
            },
          },
        },
      },
      responses: { 200: missionResponse },
    },
  },
  "/api/missions/{id}/interrupt": {
    post: {
      tags: ["Missions"],
      operationId: "interruptMission",
      parameters: id,
      responses: { 200: missionResponse },
    },
  },
  "/api/missions/{id}/retry": {
    post: {
      tags: ["Missions"],
      operationId: "retryMission",
      parameters: id,
      responses: { 201: missionResponse },
    },
  },
  "/api/missions/{id}/fork": {
    post: {
      tags: ["Missions"],
      operationId: "forkMission",
      parameters: id,
      responses: { 201: missionResponse },
    },
  },
  "/api/missions/{id}/archive": {
    post: {
      tags: ["Missions"],
      operationId: "archiveMission",
      parameters: id,
      responses: { 200: missionResponse },
    },
  },
  "/api/missions/{id}/approval": {
    post: {
      tags: ["Missions"],
      operationId: "resolveMissionApproval",
      parameters: id,
      responses: { 200: missionResponse },
    },
  },
  "/api/providers/capabilities": {
    get: {
      tags: ["Provider capabilities"],
      operationId: "getProviderCapabilities",
      responses: {
        200: { description: "Feature flags, provider health, models, controls, and access labels" },
      },
    },
  },
  "/api/codex/remote/status": {
    get: {
      tags: ["Codex Remote"],
      operationId: "getCodexRemoteStatus",
      responses: { 200: { description: "Native Remote status" } },
    },
  },
  "/api/codex/remote/start": {
    post: {
      tags: ["Codex Remote"],
      operationId: "startCodexRemote",
      responses: { 200: { description: "Started" } },
    },
  },
  "/api/codex/remote/stop": {
    post: {
      tags: ["Codex Remote"],
      operationId: "stopCodexRemote",
      responses: { 200: { description: "Stopped" } },
    },
  },
  "/api/codex/remote/pair": {
    post: {
      tags: ["Codex Remote"],
      operationId: "pairCodexRemote",
      description: "Returns a short-lived code. Jarvis does not persist or log it.",
      responses: { 200: { description: "Pairing code and expiry" } },
    },
  },
};

module.exports = { tags, schemas, paths };
