/**
 * @file project-tools.ts
 * @description Read-only access to a project's actual repo (Phase T4): list/read
 * files past whatever's indexed in the vault, and run graphify's own
 * query/explain/path/affected CLI for questions the vault's overview note can't
 * answer. Pairs with vault-tools.ts, which only sees indexed notes.
 * @author Jarvis (Phase T4)
 */

import { z } from "zod";
import { createToolRegistrar } from "../../core/tool-registry.js";
import type { ToolContext } from "../../types/tool-context.js";

export function registerProjectTools(context: ToolContext): void {
  const { api, logger, server } = context;
  const register = createToolRegistrar(server, logger);

  register(
    "dashboard_project_list_files",
    "List files in a project's repo on disk (git-tracked + untracked, gitignore-respected), optionally scoped to a subpath.",
    {
      project_id: z.string().min(1).max(256),
      subpath: z.string().max(500).optional(),
    },
    async (args) => {
      return api.get("/api/vault/project-files", {
        query: {
          projectId: args.project_id as string,
          subpath: args.subpath as string | undefined,
        },
      });
    }
  );

  register(
    "dashboard_project_read_file",
    "Read one file's contents from a project's repo on disk (utf8, capped at 2MB).",
    {
      project_id: z.string().min(1).max(256),
      path: z.string().min(1).max(1000),
    },
    async (args) => {
      return api.get("/api/vault/project-file", {
        query: { projectId: args.project_id as string, path: args.path as string },
      });
    }
  );

  register(
    "dashboard_project_codequery",
    "Run graphify's query CLI against a project's repo for questions about code structure: `query` (search symbols), `explain` (describe a symbol), `path` (dependency path between two symbols), `affected` (blast radius of a change).",
    {
      project_id: z.string().min(1).max(256),
      subcommand: z.enum(["query", "explain", "path", "affected"]),
      args: z.array(z.string()).max(20).optional(),
    },
    async (args) => {
      return api.post("/api/vault/graphify/query", {
        body: {
          projectId: args.project_id,
          subcommand: args.subcommand,
          args: args.args ?? [],
        },
      });
    }
  );
}
