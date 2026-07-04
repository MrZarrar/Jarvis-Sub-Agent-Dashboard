/**
 * @file OpenAPI 3.0 fragment for Projects (Phase F, `server/routes/projects.js`,
 * mounted at `/api/projects`). The dashboard-native organizing dimension over
 * sessions/runs/chats — separate from Claude.ai's own "Projects" feature.
 * Plain CRUD, no process-spawning, so no extra CSRF guard beyond the global
 * host/CORS/token gate (see server/index.js).
 *
 * Merged into the base spec by `server/openapi-extra.js`. Exports exactly
 * `{ tags, schemas, paths }`; the shared `ErrorResponse` envelope is
 * referenced, never redefined.
 */

const tags = [
  {
    name: "Projects",
    description:
      "Dashboard-native organizing dimension over sessions/runs/chats — auto-associated by cwd → project_paths prefix match, or tagged explicitly.",
  },
];

const errorResponse = {
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
};

const schemas = {
  Project: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "paused", "done"] },
      repo_path: { type: "string", nullable: true },
      notes_dir: { type: "string", nullable: true },
      created_at: { type: "string" },
      updated_at: { type: "string" },
    },
  },
  ProjectPath: {
    type: "object",
    properties: {
      id: { type: "string" },
      project_id: { type: "string" },
      repo_path: { type: "string" },
      created_at: { type: "string" },
    },
  },
  ProjectRollup: {
    type: "object",
    properties: {
      sessionCount: { type: "integer" },
      runCount: { type: "integer" },
      chatCount: { type: "integer" },
      recentSessions: { type: "array", items: { type: "object" } },
      recentRuns: { type: "array", items: { type: "object" } },
      recentChats: { type: "array", items: { type: "object" } },
      lastActivityAt: { type: "string", nullable: true },
    },
  },
};

const paths = {
  "/api/projects": {
    get: {
      tags: ["Projects"],
      summary: "List projects",
      operationId: "projectsList",
      parameters: [
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: ["active", "paused", "done"] },
        },
      ],
      responses: {
        200: {
          description: "Projects, each with a lightweight rollup (limit 3 recent items)",
        },
      },
    },
    post: {
      tags: ["Projects"],
      summary: "Create a project",
      operationId: "projectsCreate",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                status: { type: "string", enum: ["active", "paused", "done"] },
                repoPath: {
                  type: "string",
                  description: "Optional; also registers as the first project_paths entry.",
                },
                notesDir: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        201: { description: "Created project" },
        400: { description: "Bad input (e.g. missing name)", ...errorResponse },
      },
    },
  },
  "/api/projects/{id}": {
    get: {
      tags: ["Projects"],
      summary: "Get a project with its full rollup and paths",
      operationId: "projectsGet",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Project + rollup + paths" },
        404: { description: "Not found", ...errorResponse },
      },
    },
    patch: {
      tags: ["Projects"],
      summary: "Edit a project (name/description/status/repoPath/notesDir)",
      description:
        'Also used to archive a project — set status to "done". A non-empty repoPath not already registered is added as a new project_paths entry.',
      operationId: "projectsUpdate",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                status: { type: "string", enum: ["active", "paused", "done"] },
                repoPath: { type: "string" },
                notesDir: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Updated project" },
        404: { description: "Not found", ...errorResponse },
      },
    },
    delete: {
      tags: ["Projects"],
      summary: "Delete a project",
      description:
        "Un-tags (never deletes) the sessions/runs/chats it grouped — only the organizing label is removed.",
      operationId: "projectsDelete",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Deleted" },
        404: { description: "Not found", ...errorResponse },
      },
    },
  },
  "/api/projects/{id}/paths": {
    get: {
      tags: ["Projects"],
      summary: "List a project's repo paths",
      operationId: "projectsListPaths",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Repo paths" },
        404: { description: "Not found", ...errorResponse },
      },
    },
    post: {
      tags: ["Projects"],
      summary: "Add a repo path",
      description:
        "Enables cwd → project auto-association for that path and retroactively backfills any existing session/run whose cwd matches and has no project yet.",
      operationId: "projectsAddPath",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["repoPath"],
              properties: { repoPath: { type: "string" } },
            },
          },
        },
      },
      responses: {
        201: { description: "Path added; backfilled { sessions, runs } counts" },
        400: { description: "Bad input", ...errorResponse },
        404: { description: "Project not found", ...errorResponse },
      },
    },
  },
  "/api/projects/{id}/paths/{pathId}": {
    delete: {
      tags: ["Projects"],
      summary: "Remove a repo path",
      operationId: "projectsRemovePath",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "pathId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: { description: "Removed" },
        404: { description: "Not found on this project", ...errorResponse },
      },
    },
  },
};

module.exports = { tags, schemas, paths };
