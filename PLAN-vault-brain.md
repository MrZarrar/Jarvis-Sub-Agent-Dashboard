# PLAN — Vault Brain (Phase T): Obsidian + auto-linking engine + Graphify

> **Status: LANDED 2026-07-10** (commits 23a1b97 T2 engine, 1c27b4e T3 graphify,
> 586db98 UI/animation, 3e685db docs). Deltas from the plan below, locked with
> the user: **no Ollama** (Gemini API key + `claude -p` OAuth session only);
> **manual runs only, no cron**; graphify extraction is `--code-only` + labeling
> via `--backend=claude-cli` (all free / plan usage); **full per-node Obsidian
> export with containment** — codegraph folders are Obsidian-only (watcher +
> engine skip them), one overview note per codegraph in the dashboard graph;
> entity types extended with `event` + `technology`; links block swapped by raw
> text replacement (frontmatter never round-tripped); plus a live neural
> "thinking" animation on the Vault page driven by `vault_engine` WS events.

Goal: the vault stops being a passive markdown index and becomes a second brain
that builds its own connections. Three tracks:

- **T1 — Obsidian adoption**: Obsidian becomes the human front-end for
  `~/JarvisNotes`. Near-zero code — the vault is already Obsidian-compatible.
- **T2 — Entity engine**: a daily (and on-demand) pass that extracts entities
  (people, projects, topics) from new/changed notes, tracks mentions, promotes
  a repeatedly-mentioned entity into a real node file, and writes the wikilinks
  itself. This is the core of the phase.
- **T3 — Graphify bridge**: each project repo gets a Graphify knowledge graph
  exported into the vault, so agents traverse ONE vault for personal knowledge
  AND cross-project code context.

Existing infra this rides (no rebuilds):

- `server/lib/notes.js` — watcher + FTS5 index; already ignores dotfolders, so
  `.obsidian/` never pollutes the index.
- `server/lib/vault.js` — wikilink edge index (`vault_edges`), guardrailed
  writes, PARA folders, `graph()`/`node()`/`pathBetween()`.
- `server/lib/brain/router.js` — tiered LLM routing (Ollama → Gemini → claude).
  Extraction is a `simple` task → Ollama on the 24/7 PC, free and private.
- `server/lib/scheduler.js` — `registerRecurringTask` for the daily run.

---

## T1 — Obsidian adoption (user task + tiny code)

**User does** (see "Before I start" at the bottom):
1. Install Obsidian, "Open folder as vault" → `~/JarvisNotes`.
2. Turn off Obsidian's "Wikilinks → shortest path" nothing needed — defaults fine.

**Code (small):**
- T1.1 Add `.obsidian/` to the vault's `.gitignore` if the vault is ever
  git-tracked; confirm watcher skip (already true — `notes.js:326` skips
  dotfolders). Mostly a verification step.
- T1.2 Vault page (`client/src/pages/Vault.tsx`): "Open in Obsidian" affordance
  per note via the `obsidian://open?vault=JarvisNotes&file=<relpath>` URI.
  One anchor tag, no library.

Both editors coexist: Obsidian edits land on disk → existing watcher reindexes
→ dashboard graph updates. No sync layer needed.

## T2 — Entity engine (the second brain)

### Design rules (locked unless you object — see Questions)

- **Files stay the system of record.** The engine's links must be visible in
  Obsidian, so they must be written INTO the markdown, not only into SQLite.
- **Engine never touches human prose.** It only appends/rewrites one clearly
  fenced block at the very end of a note:

  ```markdown
  <!-- jarvis:links -->
  Related: [[Afroze]], [[Travel Vogue]]
  <!-- /jarvis:links -->
  ```

  Everything between the markers is engine-owned and idempotently regenerated;
  everything outside is untouched. This is a deliberate, narrow exception to
  the "never modify existing notes" guardrail — scoped to the block only.
- **Promotion on second mention** (your rule): first mention of an unknown
  entity is recorded in the DB only. When the same entity appears in a
  *second, different* note, the engine creates the node file
  (`people/afroze.md` / `reference/<topic>.md`, frontmatter `source: engine`)
  and adds `[[...]]` links to *all* mentioning notes' engine blocks — so the
  song lyric that mentioned Afroze first gets linked retroactively.
- **Entities that already have notes** (e.g. `people/mushaf-zarrar.md`) link on
  first mention — the node exists, no promotion needed.

### Schema (migration-safe additions in `server/db.js`)

- `vault_entities(id, name, type, aliases_json, note_id NULLABLE, created_at)`
  — `note_id` filled when promoted to a real file.
- `vault_mentions(entity_id, note_id, UNIQUE(entity_id, note_id))`
- settings key `vault_engine_last_run` (ISO timestamp cursor).

Mention counting = `COUNT(*)` over `vault_mentions`; no counter column.

### Steps

- T2.1 **Extractor** — new `server/lib/vault-engine.js`. For each note with
  `updated_at > last_run` (skip `agent/` codegraph exports, see T3):
  brain-router `simple` call: *"Extract named entities from this note as JSON:
  `[{name, type: person|project|organization|topic|place, aliases}]`. Only
  entities meaningful to a personal knowledge base."* Parse defensively
  (Ollama JSON can be sloppy; on parse failure, skip the note, log, move on —
  fail-safe like everything else in this repo).
- T2.2 **Matcher** — normalize with the existing `normalizeKey()`; match
  against `vault_entities` names+aliases and existing note titles/basenames
  (reuse `resolveKey`). New match rule: alias-aware ("Afroze" ↔ "Afroze Khan"
  via the aliases array; exact-normalized only, no fuzzy matching v1).
- T2.3 **Promoter** — entity with ≥2 distinct mentioning notes and no
  `note_id` → create node file via existing `writeVaultFile` (extend WRITABLE
  with engine-only paths `people/`, `reference/` for `source: "engine"`
  callers; humans' guardrail unchanged for agents). Node body: one-line stub +
  "Mentioned in" is unnecessary — backlinks cover it in both Obsidian and the
  dashboard.
- T2.4 **Linker** — regenerate the `jarvis:links` block in each mentioning
  note for all entities that HAVE a node. Rewrite is idempotent (same set →
  no write → no watcher churn). Watcher then reindexes → `vault_edges` pick
  the links up through the existing pipeline — the engine writes markdown,
  never edges directly. One mechanism, no divergence.
- T2.5 **Scheduling + API** — `scheduler.registerRecurringTask({name:
  "vault-engine", intervalMs: 24h})` firing the pass; plus
  `POST /api/vault/engine/run` (manual trigger) and
  `GET /api/vault/engine/status` (last run, notes scanned, entities created).
  Button + status line on the Vault page.
- T2.6 **Tests** — extractor parse fallback, promotion-on-second-mention,
  idempotent block rewrite, guardrail still blocks agent writes outside
  inbox/agent. `npm run test:server`.

Deferred (YAGNI until the graph proves noisy): entity merge UI, fuzzy name
matching, embeddings/semantic similarity, edge weights, decay. Backlog note.

## T3 — Graphify bridge (code context in the vault)

Graphify ([Graphify-Labs/graphify](https://github.com/safishamsi/graphify)) is
a local CLI + agent skill: Tree-sitter parse of a repo → `graph.json`,
`GRAPH_REPORT.md`, optional Obsidian export (one note per node + canvas),
SHA256 cache so re-runs are incremental. Everything local, no code leaves the
machine.

- T3.1 **Per-project opt-in** — settings key `vault_graphify_projects`
  (mirror of `vault_summary_projects`, same Settings UI pattern).
- T3.2 **Runner** — in `vault-engine.js`, after the entity pass: for each
  opted-in project, run graphify against its `repo_path`, export the Obsidian
  vault into `~/JarvisNotes/projects/<project-slug>/codegraph/`. That folder
  is engine-owned and regenerated wholesale each run (graphify regenerates
  exports from scratch — never put human notes in it).
- T3.3 **Index containment** — codegraph exports can be thousands of notes.
  Contain them: (a) `nodeType()` returns `"code"` for `projects/*/codegraph/`,
  (b) dashboard graph view collapses each codegraph to ONE node linked to the
  project stub (expand on click later if wanted), (c) entity engine skips
  `codegraph/` folders, (d) FTS keeps indexing them — code search from the
  dashboard is a feature, not a bug.
- T3.4 **Stitch** — append a `[[<project> codegraph]]` link into each opted-in
  project's stub note's `jarvis:links` block, so personal graph and code graph
  connect at the project hub.
- T3.5 **Agent traversal** — nothing new to build: agents already reach the
  vault through the existing MCP vault tools, and graphify ships its own skill
  for querying `graph.json` directly inside each repo. Point both at the same
  vault; done. Add one `docs/` paragraph telling agents where codegraphs live.

## Order & verification

T1 → T2 → T3; each lands independently behind its own commit.
Backend: `npm run test:server`. Frontend: `npm run test:client` (snapshot
regen for Vault page changes). Manual: drop a note mentioning a new person
twice across two notes → run engine → node file appears, both notes gain the
link, Obsidian graph shows the cluster.

---

## Before I start — your tasks

1. **Install Obsidian** and open `~/JarvisNotes` as a vault (no plugins needed
   for v1; the graph view works out of the box).
2. **Install Graphify** from its README
   ([github.com/safishamsi/graphify](https://github.com/safishamsi/graphify))
   and run it once by hand on one repo (e.g. jarvis-dashboard) so we know the
   CLI name, flags, and export layout on your machine before I script T3.2
   around it. Paste me the command you ran and the output folder structure.
3. **Confirm Ollama** is running and reachable from wherever the dashboard
   server runs, with a model pulled that handles JSON extraction decently
   (e.g. `llama3.1:8b` or `qwen2.5:7b`). The engine falls back to Gemini →
   claude via the existing router if it's down, but Ollama keeps the daily
   pass free.

## After it lands

- Opt projects into graphify + run summaries in Settings.
- Skim `people/` and `reference/` weekly at first — engine-created stubs with
  wrong types or dupes are just files; rename/merge/delete in Obsidian and the
  index follows.

## Questions

1. **Engine block in human notes** — OK for the engine to append the fenced
   `jarvis:links` block to notes you wrote (never touching your prose)?
   Without this, auto-links exist only in the dashboard DB and Obsidian's
   graph never sees them. I strongly recommend yes; it's the whole point.
2. **Graphify export size** — full per-node export (rich graph, thousands of
   files per repo) or `GRAPH_REPORT.md` + community summaries only (lean, but
   agents fall back to graph.json for detail)? Plan assumes full export with
   the T3.3 containment; say "lean" if you'd rather start small.
3. **Entity types** — v1 extracts person/project/organization/topic/place.
   Trim or extend?
4. **Daily run time** — any preferred hour (e.g. 4am), or is "every 24h from
   server boot" fine for v1?
