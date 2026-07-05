# PLAN: Jarvis Knowledge Vault (Phase S)

S0 planning doc, written 2026-07-05 with the user (reverse-prompted). S1/S2/S3
build against this spec. Parent: `PLAN-jarvis-v2.md` → Phase S.

## Decisions (locked with the user, 2026-07-05)

| Decision | Choice |
|---|---|
| Notes' fate | **Notes become one part of the vault** — the vault is the umbrella; notes hold specific items, the vault holds everything. The notes dir IS the vault dir (one file tree). The Notes page stays (it's the note-editing surface); Vault is a new top-level section over the whole tree |
| Folder structure | **PARA-style**: `inbox/ projects/ people/ reference/ daily/ agent/` (agent/runs, agent/chats). Agents write only under `inbox/` or `agent/`; never overwrite human notes (unique paths always) |
| Auto-population v1 | **Run/session summaries** (brain `standard` on run completion, opt-in per project) + **chat save-to-vault** (manual per-message save and whole-conversation summary). Entity auto-extraction and briefing/capture rerouting: deferred |
| Retrieval v1 | **FTS5 + graph traversal** (backlinks/neighbors/path). Semantic embeddings deferred — additive vectors table later, no rework |

## Architecture (S1 substrate)

- **Files stay the system of record** (Obsidian-compatible). Every `.md` under
  the vault dir is a node; the existing `notes` table is the node index —
  no `vault_nodes` table. Node **type** is derived from the top-level folder,
  never stored (`agent/runs/` → `run`, `agent/chats/` → `chat`, `projects/` →
  `project`, `people/` → `person`, `daily/` → `daily`, `reference/` →
  `reference`, `inbox/` → `capture`, root/other → `note`) — materialized
  entities land in typed folders, so folder-derivation is sufficient and needs
  zero schema.
- **One new table** (additive): `vault_edges(src_id, dst_key, dst_id, type)`.
  `dst_key` is the normalized wikilink target — lowercase, whitespace/
  underscores folded to `-`, `.md` stripped — so `[[Jarvis Project]]` resolves
  to `jarvis-project.md` (titles AND file basenames answer as targets), and
  unresolved links survive until the target appears. Edge types v1:
  `link` (wikilink `[[...]]`), `project` (frontmatter `project:` → the
  project's vault stub file).
- **Indexing rides the existing pipeline**: `notes.js` gains an optional
  indexed/removed hook that `server/lib/vault.js` registers — wikilinks are
  (re)parsed exactly when a file is (re)indexed, and pending edges pointing at
  a new file's title are re-resolved then. The fs.watch → debounce →
  `note_changed` WS path is untouched; the graph UI refreshes off
  `note_changed` (no new WS type — deliberate, the payload need is identical).
- **Project stub materialization**: opting a project into summaries (or the
  first summary for it) creates `projects/<slug>.md` with frontmatter
  `{type: project, project: <id>}`. Other dashboard entities materialize the
  same way — as files — when a writer produces them (runs → `agent/runs/`,
  chats → `agent/chats/`). No shadow rows anywhere.

## API (S1, all additive)

- `GET  /api/vault/graph` → `{nodes:[{id,title,type,tags,updatedAt}], edges:[{src,dst,type}]}` (resolved edges only)
- `GET  /api/vault/node/:id` → note body + outgoing links + backlinks
- `GET  /api/vault/path?from=&to=` → shortest link path (BFS over edges)
- `GET/PUT /api/vault/summary-projects` → opt-in project-id list
  (`app_settings.vault_summary_projects`, JSON array, empty default)
- `POST /api/vault/save-chat` `{chatId, mode:"message"|"summary", messageId?}`
  → files under `agent/chats/`
- Search stays `GET /api/notes?q=` (FTS5 already ranks the whole tree).

## Writers (S2)

- **Run summaries**: `run-spawner.onRunStatus` → terminal status → map `cwd`
  to a project via `project_paths` → in the opt-in list? → brain
  `complete({taskClass:"standard", intent:"vault_summary"})` over the run's
  prompt + output tail → `agent/runs/<date>-<slug>.md` with a `[[project]]`
  wikilink. Fail-safe: any error is logged, never breaks run teardown.
- **Chat save**: per-message save button + conversation-summary action on the
  Chat page → `POST /api/vault/save-chat`.

## Agent navigation (S2)

- Registry actions (all `risk: safe` — read-only or write-into-agent-space
  only, mirroring the existing `write_note`): `vault_search`, `vault_read`,
  `vault_write` (targets `inbox/` or `agent/` only, always a fresh file),
  `vault_backlinks`, `vault_neighbors`, `vault_path`.
- MCP: `mcp/src/tools/domains/vault-tools.ts` — same six as
  `dashboard_vault_*` tools over the HTTP API (writes behind
  `assertMutationsEnabled`, same as other domains).

## Graph-brain view (S3)

- `/vault` (also `/vault/graph`) — the graph IS the landing surface:
  d3-force (d3 v7 already a client dep) layout rendered to **canvas**
  (thousands of nodes; DOM/SVG won't hold). Colored by type cluster via theme
  tokens, node radius by degree, hover = neighborhood highlight, click =
  side panel (markdown body + backlinks), double-click = focus the local
  neighborhood, `?focus=<id>` deep link (what mini-Jarvis emits), search +
  type filter, wheel/pinch zoom, drag pan, labels fade out when zoomed out
  (LOD). Refreshes on `note_changed` (debounced refetch).
- Sidebar nav entry `Vault` (+ nav.json en/tr/zh); mobile reachable via the
  same routes, touch pan/pinch supported.

## Deferred (explicitly, v1 ceilings)

- Entity auto-extraction (people/tools/topics via brain `simple`) — biggest
  dedupe risk; add once the vault has real content.
- Semantic search (Ollama embeddings, vectors table) — additive later.
- Briefings/captures rerouting into vault folders — they already land as
  notes in the tree and therefore appear as nodes today.
- `vault_changed` WS type — `note_changed` already fires on every vault file
  change; add a richer payload only if neighborhood-level patching is ever
  needed for perf.
- Semantic/typed edges beyond `link` + `project` (mentions, about-person,
  derived-from) — the `type` column is already there; writers can mint new
  types without schema change.

## Verification gates

- `npm run test:server` (edge parsing/resolution, folder-type derivation,
  save-chat, summary opt-in gating, vault_write guardrails, BFS path).
- `npm run test:client` (Vault page snapshot; review churn deliberately).
- `npm run mcp:typecheck` + `npm run mcp:build`.
- Live: create two notes linking each other → graph shows the edge; save a
  chat message → node appears under `agent/chats`; `?focus=` deep link
  centers the node. Smooth pan on a realistically populated vault is the S3
  gate (desktop + phone).
