/**
 * @file Supplementary OpenAPI 3.0 fragments for the GitHub dev-workflow panel
 * routes mounted at `/api/github` (see server/routes/github.js). Exports
 * `{ tags, schemas, paths }` merged into the base spec by `createOpenApiSpec()`.
 * Schemas are prefixed `GitHub` to avoid collisions. Error responses reuse the
 * base `MessageErrorResponse` shape (`{ error: { code, message } }`).
 * @author Jarvis (Phase I)
 */

const tags = [
  {
    name: "GitHub",
    description:
      "Dev-workflow panel: open PRs (review-requested / mine), CI status, and recent issues across configured repos. Backed by the local `gh` CLI or a configured PAT (server-side only).",
  },
];

const schemas = {
  GitHubPr: {
    type: "object",
    properties: {
      repo: { type: "string", example: "MrZarrar/jarvis-dashboard" },
      number: { type: "integer", example: 42 },
      title: { type: "string" },
      url: { type: "string", format: "uri" },
      author: { type: "string", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
      isDraft: { type: "boolean" },
      reviewDecision: { type: "string", nullable: true, example: "REVIEW_REQUIRED" },
      ci: {
        type: "string",
        enum: ["success", "failure", "pending", "none", "unknown"],
        description: "CI rollup state. `unknown` in PAT mode (per-PR checks aren't fetched there).",
      },
    },
  },
  GitHubIssue: {
    type: "object",
    properties: {
      repo: { type: "string" },
      number: { type: "integer" },
      title: { type: "string" },
      url: { type: "string", format: "uri" },
      author: { type: "string", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
    },
  },
  GitHubLatestCommit: {
    type: "object",
    description:
      "The most recent commit on a repo's default branch - a human-readable summary (branch + message), never the raw SHA. `url` links to the commit for anyone who wants the hash.",
    properties: {
      repo: { type: "string" },
      branch: { type: "string", example: "main" },
      message: {
        type: "string",
        description: "The commit subject line (first line of the message).",
      },
      isMerge: { type: "boolean" },
      mergedPr: {
        type: "object",
        nullable: true,
        description:
          'Present when isMerge is true and the message matches GitHub\'s default "Merge pull request #N from owner/branch" format.',
        properties: {
          number: { type: "integer" },
          fromRef: { type: "string", example: "owner/feature-x" },
          title: {
            type: "string",
            nullable: true,
            description:
              "The PR title, when it appears on the following body line (GitHub's default format).",
          },
        },
      },
      author: { type: "string", nullable: true },
      date: { type: "string", format: "date-time", nullable: true },
      url: { type: "string", format: "uri", nullable: true },
    },
  },
  GitHubOverview: {
    type: "object",
    properties: {
      configured: { type: "boolean" },
      mode: { type: "string", enum: ["gh", "pat", "none"] },
      me: { type: "string", nullable: true },
      repos: { type: "array", items: { type: "string" } },
      counts: {
        type: "object",
        properties: {
          reviewRequested: { type: "integer" },
          mine: { type: "integer" },
          failingChecks: { type: "integer" },
          openIssues: { type: "integer" },
        },
      },
      reviewRequested: { type: "array", items: { $ref: "#/components/schemas/GitHubPr" } },
      mine: { type: "array", items: { $ref: "#/components/schemas/GitHubPr" } },
      issues: { type: "array", items: { $ref: "#/components/schemas/GitHubIssue" } },
      latest: {
        type: "array",
        items: { $ref: "#/components/schemas/GitHubLatestCommit" },
        description: "One entry per configured repo (when fetchable), newest first.",
      },
      error: { type: "string", nullable: true },
    },
  },
  GitHubOverviewResponse: {
    type: "object",
    properties: {
      overview: { $ref: "#/components/schemas/GitHubOverview" },
      fetchedAt: { type: "string", format: "date-time", nullable: true },
      error: { type: "string", nullable: true },
      mode: { type: "string", enum: ["gh", "pat", "none"] },
      configured: { type: "boolean" },
    },
  },
  GitHubConfig: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      hasPat: {
        type: "boolean",
        description: "Whether a PAT is stored (the token itself is never returned).",
      },
      repos: { type: "array", items: { type: "string", example: "owner/name" } },
      pollMinutes: { type: "integer", minimum: 1, maximum: 180 },
    },
  },
  GitHubConfigResponse: {
    type: "object",
    properties: { config: { $ref: "#/components/schemas/GitHubConfig" } },
  },
};

const paths = {
  "/api/github": {
    get: {
      tags: ["GitHub"],
      operationId: "getGithubOverview",
      summary: "Cached GitHub overview across configured repos",
      responses: {
        200: {
          description: "The last cached overview (served from SQLite).",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/GitHubOverviewResponse" } },
          },
        },
      },
    },
  },
  "/api/github/refresh": {
    post: {
      tags: ["GitHub"],
      operationId: "refreshGithub",
      summary: "Force a fresh poll now",
      description:
        "Spawns the `gh` CLI (or hits the REST API in PAT mode), updates the cache, and broadcasts `github_updated` on a delta.",
      responses: {
        200: {
          description: "The freshly-fetched overview.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/GitHubOverviewResponse" } },
          },
        },
        500: {
          description: "Fetch failed.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MessageErrorResponse" } },
          },
        },
      },
    },
  },
  "/api/github/config": {
    get: {
      tags: ["GitHub"],
      operationId: "getGithubConfig",
      summary: "Redacted GitHub config",
      responses: {
        200: {
          description: "Config with the PAT redacted to a boolean.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/GitHubConfigResponse" } },
          },
        },
      },
    },
    put: {
      tags: ["GitHub"],
      operationId: "updateGithubConfig",
      summary: "Update GitHub config",
      description:
        "Partial patch: `{ enabled?, pat?, repos?, pollMinutes? }`. The PAT is stored server-side and never echoed back.",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                pat: { type: "string", description: "Personal Access Token (write-only)." },
                repos: { type: "array", items: { type: "string", example: "owner/name" } },
                pollMinutes: { type: "integer", minimum: 1, maximum: 180 },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "The updated redacted config.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/GitHubConfigResponse" } },
          },
        },
        400: {
          description: "Invalid patch.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MessageErrorResponse" } },
          },
        },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
