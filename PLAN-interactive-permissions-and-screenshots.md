# Plan: Interactive Permissions + Screenshots in Stream

One slice, for execution in a fresh session. Scope: **dashboard-spawned runs only**
(Run page) — external/terminal sessions are explicitly out of scope (confirmed
with user; VSCode-extension-driven control is a future slice, not this one).

Read `CLAUDE.md`, `.claude/rules/*`, and `ARCHITECTURE.md` first for the
project's non-negotiables (non-blocking hooks, backward-compatible API
responses, minimal diffs) before touching anything below.

---

## What was verified before writing this plan (don't re-derive)

- `claude --help` on this machine has **no `--permission-prompt-tool` flag**.
  Do not build an MCP-permission-server approach — it doesn't exist on this
  CLI version. `--permission-mode` choices are: `acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, `plan`.
- `claude --print --output-format stream-json` supports `--include-hook-events`
  ("Include all hook lifecycle events in the output stream"). Worth spiking as
  a *visibility* channel, but PreToolUse hook JSON-decision gating (below) is
  the actual control mechanism, independent of this flag.
- This repo's **existing** `PreToolUse` hook (`scripts/hook-handler.js`,
  installed via `scripts/install-hooks.js`) is deliberately fire-and-forget —
  it POSTs to the dashboard and exits within ~2.5s (see `setTimeout(() =>
  process.exit(0), 2500)`). It is NOT a gate today. Do not repurpose it — add
  a **second, separate** PreToolUse hook script instead (see Architecture).
- `scripts/install-hooks.js` already supports multiple hook commands per
  event: `HOOKS_WITH_MATCHER` includes `PreToolUse` with `matcher: "*"`, and
  the installer identifies "its own" entries by checking
  `command.includes("hook-handler.js")` — so a second entry identified by a
  different filename installs additively without colliding.
- `run-spawner.js` already strips `CLAUDECODE` / `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  from the spawned child's env (`cleanSpawnEnv()`) — the natural place to also
  *inject* a run-identifying env var for the gating hook (see below).
- Conversation rendering lives in `client/src/components/conversation/`
  (`MessageList.tsx`, `ToolCallBlock.tsx`, `CodeBlock.tsx`,
  `MarkdownContent.tsx`). No image-content-block rendering exists there today
  — confirmed no `type === "image"` / `media_type` handling in that directory.
- Envelopes are capped server-side at `MAX_ENVELOPES_PER_HANDLE = 500`
  (`server/lib/run-spawner.js`) — already bounds memory growth; no change
  needed there for images, but see Phase 1 risk note on payload size.

## What is NOT yet verified — Phase 0 spike, do this first

The exact **PreToolUse hook JSON-decision protocol** (stdout shape, exit-code
semantics, whether a hook can genuinely block Claude Code's tool-call
resolution while its own process stays alive) is not confirmed against this
repo or this CLI version. Do not implement Phase 2 against assumed protocol —
spike it first:

1. Write a throwaway PreToolUse hook script that:
   - Reads the hook input JSON from stdin (existing `hook-handler.js` already
     shows the stdin-read pattern — copy it).
   - Sleeps 5s, then writes `{"hookSpecificOutput": {"hookEventName":
     "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason":
     "test"}}` to stdout and exits 0.
2. Point `~/.claude/settings.json` at it for a single PreToolUse matcher in a
   throwaway sandbox `CLAUDE_HOME` (use the same `CLAUDE_HOME` sandbox trick
   from the dev-mode skill — do NOT test against the real `~/.claude` for this
   spike).
3. Run `claude -p "read package.json" --permission-mode default` and confirm:
   (a) the tool call is actually blocked/denied, not just logged; (b) the
   5-second wait genuinely delays the turn (proves the hook process blocking
   the parent works); (c) the exact JSON key names Claude Code expects (may
   differ from the guess above — check `claude doctor` output or hook error
   messages for the real schema if the guess is rejected).
4. Confirm the **fail-open** behavior: an *unrelated* PreToolUse hook (no
   matching env var, see Architecture) that exits 0 with no stdout must leave
   the tool call completely unaffected — test this explicitly, since a wrong
   assumption here would freeze the user's normal terminal sessions once the
   hook is installed globally.
5. Only after 1–4 pass, proceed to Phase 2.

If the spike shows PreToolUse hooks cannot genuinely block (e.g. Claude Code
fires them fire-and-forget with a fixed timeout regardless of stdout), stop
and re-scope Phase 2 with the user — the whole approach depends on this.

---

## Architecture decisions

### Interactive permissions

- **New hook script**: `scripts/permission-gate.js`, registered as a
  *second* `PreToolUse` entry (matcher `"*"`) in `~/.claude/settings.json`,
  alongside the existing observability hook. Never edit `hook-handler.js`.
- **Scoping so it's a no-op for every session except opted-in dashboard
  runs**: `run-spawner.js` sets a new env var (e.g.
  `JARVIS_INTERACTIVE_PERMISSIONS=<runId>`) on the spawned child ONLY when the
  caller requests `permissionUx: "interactive"` on `POST /api/run`. The hook
  script checks this env var first; if absent, it must exit 0 with **no
  stdout** immediately (sub-50ms) so it never affects any other session,
  including plain terminal use and non-interactive dashboard runs. This is the
  single most important safety property of this feature — verify it in Phase
  0 step 4, and add a server test asserting the flag is never set unless
  explicitly requested.
- **Blocking + timeout**: when the env var is present, the hook process
  long-polls (or short-polls, ~500ms) a new dashboard endpoint until a
  decision is registered or a hard timeout elapses (recommend 10 minutes —
  long enough for a human to notice and act, short enough to never wedge a
  run indefinitely). On timeout, default to **deny** with a clear reason
  string (fail toward safety, per `CLAUDE.md`'s "never silently weaken safety
  controls" rule) — do not default-allow on timeout.
- **Server-side pending-decision store**: reuse the existing in-memory
  pattern from `run-spawner.js` (`handles` map) — a new `Map` keyed by
  `runId:toolUseId` holding `{toolName, input, resolve}`. No DB table needed;
  this is ephemeral, scoped to the life of the run, matching how
  `run-spawner.js` already treats live state.
- **New route**: `server/routes/run.js` — reuse the existing
  `sameOriginGuard` (already applied via `router.use`). Endpoints:
  - `GET /api/run/:id/permission/pending` — poll target for the hook script
    (long-poll or short-poll; pick whichever is simpler to implement
    correctly — short-poll is safer against Node's default HTTP timeouts).
  - `POST /api/run/:id/permission/:requestId` — `{decision: "allow"|"deny",
    reason?: string}`, called by the dashboard UI.
- **Broadcast**: when a permission request opens, broadcast a new WebSocket
  message type `permission_request` (mirror the shape of existing
  `run_status`/`run_stream` broadcasts in `run-spawner.js`); when resolved,
  broadcast `permission_resolved`.
- **Reuse existing "waiting" semantics where possible**: the dashboard already
  has `awaiting_input_since` on sessions/agents (set by the `Notification`
  hook, per `server/db.js`). Consider stamping it when a permission request
  opens and clearing it on resolution, so existing "waiting" badges in
  `AlertsNotifications.tsx` and session-list views light up consistently for
  this new case too — avoids inventing a second parallel "waiting" concept.
  Confirm this doesn't conflict with genuine `Notification`-hook-driven
  waiting states (e.g. don't clear one because of the other).
- **Kill/cleanup**: `killRun()` in `run-spawner.js` must resolve any pending
  permission requests for that run as `deny` before tearing down, so the hook
  process (if still polling) exits promptly instead of polling a dead run for
  10 minutes.

### Screenshots in stream

- No protocol spike needed — this is purely a rendering feature. Tool results
  already flow through the existing envelope pipeline
  (`server/lib/run-spawner.js` → `run_stream` WebSocket → client).
- **Client-only change**: extend whatever component in
  `client/src/components/conversation/` renders `tool_result` content blocks
  (start from `ToolCallBlock.tsx` / `MessageList.tsx`) to detect
  `{type: "image", source: {type: "base64", media_type, data}}` blocks and
  render an `<img>` thumbnail with a click-to-expand lightbox, styled to match
  the existing HUD/holographic panel system (`index.css` tokens — do not
  hand-roll new colors; reuse `--chart-*` / holo panel classes already in the
  codebase, per the dataviz skill's palette validator if any new color is
  genuinely needed, which it shouldn't be for a lightbox).
- **Size guard**: base64 image payloads can be large (screenshots especially).
  Confirm whether `MAX_ENVELOPES_PER_HANDLE = 500` alone is sufficient, or add
  a per-envelope size cap / truncation note server-side (e.g. skip storing the
  full base64 in the in-memory replay buffer beyond N images, replacing with a
  placeholder) so a screenshot-heavy run doesn't balloon server memory. Decide
  based on realistic screenshot sizes (test with an actual computer-use or
  Read-on-PNG tool call during Phase 1 testing) rather than guessing a number
  up front.
- Lower risk, no unknowns — sequence this **first** in execution to build
  momentum and validate the envelope-rendering pipeline before tackling the
  harder permission-gate feature.

---

## Execution sequence

1. **Phase 0** — spike the PreToolUse blocking-decision protocol (see above).
   Do this even though Phase 1 doesn't depend on it, so a dead end is
   discovered early rather than after screenshots are already shipped.
2. **Phase 1** — screenshots in stream (client-only, `conversation/` renderer
   + size-guard decision). Test manually: spawn a Run-page conversation that
   invokes a tool producing an image (Read on a PNG is the simplest
   reproducible case), confirm it renders as a thumbnail.
3. **Phase 2** — `scripts/permission-gate.js` + `install-hooks.js` extension
   (additive second PreToolUse entry) + pending-decision store in
   `run-spawner.js` + new routes + WebSocket broadcast.
4. **Phase 3** — client UI: extend `SteerPanel.tsx` (or a new sibling
   component) with a "Permission Requests" section — tool name, input
   preview, Allow/Deny buttons — wired to the new endpoints and WebSocket
   events. Confirm it degrades safely if the WebSocket is momentarily
   disconnected (per `.claude/rules/frontend-react.md`).
5. **Verification** — per `CLAUDE.md`: run `npm run test:server` and `npm run
   test:client` (regenerate the Dashboard/SessionDetail snapshot with `cd
   client && npx vitest run -u` if the UI changed, reviewing the diff before
   accepting it — never blind-update). Run `/verify` to actually drive a
   spawned run through a real permission gate end-to-end in a browser, not
   just unit tests — this feature's entire value is in the live interaction.
6. **Docs** — per `.claude/rules/docs-markdown.md` / the
   `update-project-docs` skill, update `SETUP.md` (hook table),
   `ARCHITECTURE.md` (new hook + endpoints), and `README.md` if this becomes
   a documented capability, in the same change-set.

## Explicit non-goals for this slice

- External terminal / VSCode-extension-driven sessions (flagged by the user
  as a future slice, not now — hooks can observe those sessions but the
  dashboard cannot inject stdin into a process it didn't spawn).
- Session-usage/rate-limit work (separate, already shipped this session).
- Subagent model-picker UI (separate slice, not started).
- Any change to the existing observability `hook-handler.js` — this slice is
  purely additive.
