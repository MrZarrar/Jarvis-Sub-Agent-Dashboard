/**
 * @file vault-tools.ts
 * @description Knowledge-vault tools (Phase S): search the vault, read a node with
 * its links and backlinks, traverse neighborhoods and shortest link paths, and write
 * new notes into the guardrailed agent areas (inbox/ or agent/ - the dashboard API
 * refuses anything else and never overwrites an existing note). These give any MCP
 * host (Claude Code, Claude Desktop) persistent memory over the user's vault.
 * @author Jarvis (Phase S)
 */

import { z } from "zod";
import { createToolRegistrar } from "../../core/tool-registry.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import type { ToolContext } from "../../types/tool-context.js";

export function registerVaultTools(context: ToolContext): void {
  const { api, logger, server, config } = context;
  const register = createToolRegistrar(server, logger);

  register(
    "dashboard_vault_search",
    "Search the knowledge vault (notes, run/chat memories, projects) by keyword.",
    {
      q: z.string().min(1).max(500),
    },
    async (args) => {
      return api.get("/api/notes", { query: { q: args.q as string } });
    }
  );

  register(
    "dashboard_vault_read",
    "Read one vault node: markdown body plus outgoing links and backlinks.",
    {
      node_id: z.string().min(1).max(256),
    },
    async (args) => {
      return api.get(`/api/vault/node/${encodeURIComponent(args.node_id as string)}`);
    }
  );

  register(
    "dashboard_vault_backlinks",
    "List the vault nodes that link TO a given node.",
    {
      node_id: z.string().min(1).max(256),
    },
    async (args) => {
      const res = (await api.get(
        `/api/vault/node/${encodeURIComponent(args.node_id as string)}`
      )) as { node?: { backlinks?: unknown } };
      return { backlinks: res.node?.backlinks ?? [] };
    }
  );

  register(
    "dashboard_vault_neighbors",
    "List a vault node's direct neighborhood (resolved links out and in).",
    {
      node_id: z.string().min(1).max(256),
    },
    async (args) => {
      const res = (await api.get(
        `/api/vault/node/${encodeURIComponent(args.node_id as string)}`
      )) as { node?: { outgoing?: Array<{ resolved?: boolean }>; backlinks?: unknown } };
      const outgoing = (res.node?.outgoing ?? []).filter((o) => o.resolved);
      return { outgoing, incoming: res.node?.backlinks ?? [] };
    }
  );

  register(
    "dashboard_vault_path",
    "Shortest chain of linked vault nodes connecting two node ids.",
    {
      from_id: z.string().min(1).max(256),
      to_id: z.string().min(1).max(256),
    },
    async (args) => {
      return api.get("/api/vault/path", {
        query: { from: args.from_id as string, to: args.to_id as string },
      });
    }
  );

  register(
    "dashboard_vault_write",
    "Write a NEW note into the vault's inbox/ or agent/ area (never overwrites).",
    {
      title: z.string().min(1).max(300),
      body: z.string().max(100_000),
      folder: z.string().max(200).optional(),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/vault/write", {
        body: {
          title: args.title,
          body: args.body,
          folder: args.folder,
        },
      });
    }
  );
}
