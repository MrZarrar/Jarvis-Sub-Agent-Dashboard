# PLAN: Jarvis v3 — post-GPT-5.6 revamp: native-first, less noise, life-ops

Written 2026-07-10 after GPT-5.6 / ChatGPT Work shipped (2026-07-09). Same
execution model as the master plan: one phase per fresh session, every session
reads `CLAUDE.md`, `.claude/rules/*`, `ARCHITECTURE.md` first. Phase letters
continue v2 (which ended at AA): **AB–AF**.

---

## 1. Vision (the pivot)

OpenAI's July 2026 release made parts of this dashboard redundant: ChatGPT
Work is a cross-device agent with built-in Codex, background **computer use**,
scheduled agents, start-on-phone/run-on-Mac — much of what Phases Z/M rebuilt
by hand, but more robust. GPT-5.6 ships as three tiers (Sol/Terra/Luna) and
Codex is merged into the ChatGPT desktop app.

The dashboard therefore stops competing on "agent execution features" and
doubles down on what OpenAI cannot be:

1. **The cross-provider meta-layer**: one place that monitors Claude *and*
   Codex *and* Gemini sessions/runs/usage, over Tailscale, with push.
   ChatGPT Work only sees GPT; Claude Code only sees Claude. Jarvis sees all.
2. **Personal ops**: daily todo board, Monday.com, subscriptions/finance,
   notes/vault, briefings — the life layer no vendor agent owns.
3. **Less noise**: the per-tool envelope firehose was built for debugging
   agents, not living with them. Default views go agent-level.

Anything a vendor now does natively gets a deep link, not a rebuild.

### Decisions locked with the user (defaults chosen 2026-07-10 — say so to change)

| Decision | Choice |
|---|---|
| GPT plan | **ChatGPT Plus** (user buying soon). Build all Codex features against Plus sign-in; degrade gracefully until then |
| Accounts (changed 2026-07-10) | **One Claude account + one GPT account** — the two-Claude-account claude-swap setup is being dropped. Phase K's tracking already self-hides when claude-swap is absent (verified fail-safe), so nothing to remove; just **don't extend it**. The "usage" story becomes: Claude session window ring (existing) + Codex usage card (AB1) side by side |
| GPT chat in the harness | **Stays inert** — Plus is not an API key. The existing GPT slot activates only if the user separately buys API credits |
| Codex integration surface | **Codex CLI / app-server** (included in Plus): `codex exec --json` for runs, app-server `turn/steer` for steering, `~/.codex/sessions` watcher for passive monitoring |
| Computer use / remote control | **Native, not rebuilt**: ChatGPT Work for agentic computer use (once Plus); **RustDesk over Tailscale** for live screen mirroring/control from the phone. The Phase-Z2 screencapture streamer is retired |
| Screen mirroring | RustDesk (free, open source, works point-to-point over the tailnet). Dashboard ships a doc + a deep-link button, zero mirroring code |
| Monday.com | GraphQL API with a personal token (works on the free 2-user plan). Same architecture as the GitHub panel |
| Finance scope | **Subscriptions tracker only** — manual entries + paste-to-parse via the brain. No bank/Plaid integrations (cost, credentials risk, YAGNI) |
| Todo board sources | Note todos (`- [ ]`, already indexed by G2 pulse) + Monday items + scheduled prompts + waiting agents. No new todo storage — notes ARE the todo store |
| Claude Dispatch (Cowork, 2026-03) | **Native, acknowledged, not competed with.** Dispatch = phone-triggers-your-desktop for Cowork sessions — Anthropic's robust version of the dashboard's phone-spawn. The dashboard keeps its own spawn path because it does what Dispatch doesn't: provider picker (Claude/Gemini/Codex), interactive permission gating, steering, chaining/scheduling, project tagging. Verify at AB1 time whether Cowork/Dispatch sessions land in `~/.claude` in a cc-watcher-visible shape — if so they appear in the dashboard for free |

### Honest constraints (surface these, don't work around them)

- **ChatGPT Plus ≠ OpenAI API.** No API key means no GPT chat adapter, no
  DALL·E/Sora, no API computer-use tool. Do not build unofficial wrappers
  around the ChatGPT app (ToS, bans). Codex CLI is the one Plus-native
  programmatic surface — that's the lane.
- **ChatGPT Work is app-only and one day old.** No public API to spawn or
  observe Work tasks was found (verify again at build time — it shipped
  2026-07-09). Until one exists, the dashboard's GPT visibility is Codex
  sessions, not Work tasks. Be honest in the UI about that boundary.
- **No headless Codex usage/limits.** `/status` (5-hour + weekly limits) is
  TUI-only; openai/codex#10233 tracks a JSON equivalent and was still open
  as of early 2026. Re-check at build time; if still missing, show what the
  session JSONLs reveal (token counts per rollout) and label the limit
  window "unknown" rather than guessing. If Codex later ships
  `codex status --json`, wire it in a follow-up — design the usage card so
  that slot exists.
- **Codex has no PreToolUse permission gate.** Same posture as gemini-cli in
  Phase E2: sandbox/approval flags on spawn (`--sandbox`, approval modes),
  and the UI must not imply interactive-permission support it doesn't have.
- **`~/.codex/sessions` layout** (`sessions/YYYY/MM/DD/rollout-*.jsonl`)
  verified on this machine 2026-07-10 (stale sessions from Aug 2025 exist).
  The rollout event schema must be derived from real files at build time,
  not from memory — it changes between Codex releases.

## 2. Current state (verified in code 2026-07-10 — don't re-derive)

- **Provider seam exists**: `server/lib/providers/` chat adapters
  (gemini/ollama/claude + inert GPT slot) and `server/lib/providers/agent/`
  (claude, gemini-cli + `gemini-stream-parser.js`) behind `run-spawner.js`'s
  `provider` field (Phase E2). Codex slots in as a third agent adapter —
  **do not touch the Claude path** (byte-identical, tests prove it).
- **Watcher pattern exists**: `server/lib/cc-watcher.js` (fs.watch on
  `~/.claude`), reused by notes (G1) and claude-swap (K). Port it, don't
  fork it conceptually.
- **Panel pattern exists**: Phase I GitHub panel
  (`server/lib/github/{config,client,service}.js`, single-row cache table,
  poll via the **shared Phase-L scheduler** `registerRecurringTask`,
  fingerprint-delta broadcast, push category, home widget + subpage,
  contextual config on the page itself). Monday.com clones this 1:1.
- **Todos already exist**: G2's pulse counts open `- [ ]` per note/project
  (`project_pulse`); notes FTS index has the excerpts. The board reads these.
- **KanbanBoard.tsx is agents/sessions**, not todos — the name collides with
  this plan's "task board"; the new page is separate (`/today`).
- **ComputerUse.tsx / Browse.tsx** (Phase Z) = home-rolled screencapture +
  System Events streaming — the "less robust rebuilt" surface this plan
  retires.
- **Push categories, scheduler, brain router, assistant endpoint** all live
  and shared — every new poller/push in this plan reuses them.

## 3. Phases

Ordering: AB is the headline (GPT-native) but needs the Plus purchase for
full verification, so its passive half lands first; AD before AC because the
board wants Monday data; AE and AF are independent fillers that can slot
anywhere.

### Phase AB — Codex/GPT native integration

*Two sessions. AB1 needs nothing (session files already on disk); AB2 needs
ChatGPT Plus + `npm i -g @openai/codex` (or brew) on the Mac.*

Session AB1 — passive monitoring (works before Plus is bought):
1. `server/lib/codex-watcher.js`: fs.watch on `~/.codex/sessions` (recursive,
   date-partitioned dirs; same fail-safe posture as `cc-watcher.js`), parse
   rollout JSONLs defensively (schema from real files, unknown event types
   skipped not fatal), upsert into the existing `sessions` surface with a
   `provider: codex` tag (additive column, migration-safe, default
   `claude` so existing rows/queries are untouched).
2. UI: provider badge on session rows/cards (Sessions, KanbanBoard,
   Operations feed); Sessions page provider filter. Codex sessions are
   read-only v1 — no steer/kill claims on surfaces that can't do it.
3. Usage: per-rollout token counts if the JSONLs carry them → a Codex card
   on Analytics with an honest "limit window unknown" state (see
   constraints; leave the slot for `codex status --json`). With the move to
   one-Claude-one-GPT, this card is the GPT half of the home usage story —
   place it beside the Claude session-window ring, same visual language.
4. **Claude Dispatch visibility check** (5 minutes, same session): trigger a
   Cowork/Dispatch task and see whether its session materializes under
   `~/.claude` in a shape the existing cc-watcher already ingests. If yes:
   nothing to build, note it in ARCHITECTURE. If no: record where Cowork
   stores sessions and whether a second watcher is worth it (likely a
   backlog item, not this phase).
5. Verify: run one real `codex` TUI session (free tier allows sign-in) and
   watch it appear live. `npm run test:server` with fixture rollouts.

Session AB2 — agentic backend + steering (needs Plus):
5. `server/lib/providers/agent/codex.js` + `codex-stream-parser.js`
   (sibling of `gemini-stream-parser.js`): spawn `codex exec --json
   [--sandbox …]`, map JSONL events → envelope shape, status lifecycle,
   kill. Spawn-form provider picker gains Codex (interactive-permissions
   toggle disabled, like gemini-cli).
6. **Steering**: prefer the app-server protocol (`codex app-server`,
   JSON-RPC; `turn/steer` appends input to an in-flight turn — this is the
   native steering the user wants) if a persistent app-server child proves
   stable; else fall back to thread continuation (`codex exec resume
   <threadId>` / SDK `resumeThread`) which is turn-by-turn, not mid-turn.
   Decide at build time against the installed CLI version; document which
   mode shipped. SteerPanel works for Codex runs either way.
7. Deep links, not rebuilds: a "ChatGPT Work" row in the Skills/home quick
   actions that just opens the ChatGPT app (`chatgpt://` scheme if it
   exists, else the web app). Nothing else — Work has no API (constraints).
8. Verify: spawn a Codex run beside a Claude run, steer it, kill it;
   `test:server` + `test:client`; Claude-path tests untouched.

### Phase AD — Monday.com panel

*One session. Clone of the GitHub panel — new code should diff-resemble
`server/lib/github/` closely enough that a reviewer sees the pattern.*

1. `server/lib/monday/{config,client,service}.js`: GraphQL POSTs to
   `https://api.monday.com/v2` with a personal API token (gitignored
   `server/config/monday.json` + env `MONDAY_TOKEN`, redacted to
   `hasToken`). `fetchOverview()`: my items grouped by board, due/overdue
   today, recent updates. Never throws; injectable fetch for tests.
2. Single-row `monday_cache` table; poll on the shared scheduler
   (`pollMinutes` config), broadcast `monday_updated` on fingerprint delta,
   new `monday` push category (item assigned to me / due today).
3. Client: `MondayWidget.tsx` on home (self-hiding until configured) +
   `MondayPanel.tsx` at `/monday` (boards/items, due lane, inline config —
   contextual config like GitHub/Notes/Skills, no Settings churn).
4. **Write-back minimum**: mark item done (`change_simple_column_value` on
   the status column) — needed by the AC board. Nothing else in v1.
5. Verify against the user's real account (free-plan token); document token
   creation in SETUP.md. `test:server` with mocked GraphQL fixtures.

### Phase AC — Today board (daily todos)

*One session. Depends on AD (Monday lane) but degrades to notes-only if AD
is skipped.*

1. `GET /api/today`: server-side aggregation, no new storage — open note
   todos (from the existing notes index; parse `- [ ]` lines with their
   note id + line ref), Monday items due/overdue (AD cache), today's
   scheduled prompts (L), waiting agents (existing stats). One endpoint,
   one shape, cached per request.
2. `Today.tsx` at `/today`: mobile-first column board — Do today / In
   flight / Done today. Checking a note todo rewrites that `- [ ]` →
   `- [x]` line in the markdown file via the existing notes write path
   (the file stays the source of truth — Obsidian sees it); checking a
   Monday item calls AD's write-back; agent/schedule rows deep-link, they
   don't complete from here.
3. Make it the **first mobile tab** (MobileTabBar: Today replaces Home as
   the default landing on phone; desktop home unchanged). This is the
   "glance at my phone over coffee" surface.
4. Morning briefing (J) gains a "top of today" line composed from the same
   endpoint — one sentence, not a second aggregator.
5. Verify on-device over the tailnet: check a todo on the phone, watch the
   markdown file change on disk. `test:server` for the aggregator +
   line-rewrite (fixture vault), `test:client`.

### Phase AE — Subscriptions & finance tracker

*One session. Independent.*

1. Additive `subscriptions` table: name, amount, currency, cadence
   (monthly/yearly/custom-days), next_renewal, category, notes, active.
   Server does the date math (`nextRenewal` rolls forward on save/poll).
2. `/api/subscriptions` CRUD + `GET /api/subscriptions/summary` (monthly
   burn normalized across cadences, next 7-day renewals). Renewal push
   (new `finance` category) 2 days before, fired from the shared
   scheduler's daily tick — reuse the briefing tick pattern, don't add a
   scheduler.
3. `Finance.tsx` at `/finance`: summary header (monthly burn, yearly
   projection, next renewal), list with inline edit, add form. A brain
   assist: paste a bank-statement / receipts blob → `standard`-tier prompt
   extracts candidate subscriptions for confirm-before-save (same
   raw→formatted confirm UX as the G2 dump flow). Home widget: burn +
   next renewal, self-hiding when empty.
4. Briefings mention renewals ≤2 days out. `- skipped:` bank sync,
   budgets, spending analytics — add only if the tracker actually gets used.
5. Verify: seed real subscriptions, force a renewal push, check the math
   on a yearly + a monthly entry. `test:server`.

### Phase AF — Declutter + native handoff (the "remove" phase)

*One session. Independent; safe to run first if the user wants quick relief.*

1. **Agent-level default, tool-level on demand**: Operations feed and
   ActivityFeed collapse tool envelopes behind an expandable agent row; a
   per-user `verbosity` setting (`app_settings`) with default `agent`.
   Run/SessionDetail keep full tool detail — debugging surfaces stay
   verbose, ambient surfaces go quiet.
2. **Retire Phase-Z surfaces**: remove `/computer-use` and `/browse` routes
   + nav (code parked, not deleted, one release — a `LEGACY_SURFACES=1`
   env resurrects them, then delete for real next pass). The gated
   `computer_use`/`browse` assistant actions are disabled with an honest
   message pointing at the replacements.
3. **Screen mirroring, native**: SETUP.md "Remote screen" section —
   RustDesk on Mac + iPhone over the tailnet (direct IP, no relay), or
   ChatGPT Work computer-use for agentic tasks once Plus is active. Mobile
   home/Today gets a "Mirror screen" button that deep-links `rustdesk://`
   (verify the scheme on-device; fall back to a doc link).
4. **Home audit**: drop stat instruments nobody glances at (candidates:
   events/min sparkline, total-sessions) behind the same verbosity setting;
   widgets self-hide when unconfigured (GitHub/Monday/Finance already do).
5. Verify on-device: phone home screen shows Today + quiet ops feed;
   mirror-screen button lands in RustDesk. Snapshot churn is expected and
   must be reviewed deliberately (`screens.snapshot.test.tsx` covers
   Dashboard/ActivityFeed).

## 4. Sequencing

```
AB1 (codex passive)   — independent, do first (works before Plus)
AF  (declutter)       — independent (early quick win, user's top complaint)
AD  (monday)          — independent
AC  (today board)     — wants AD (degrades to notes-only)
AE  (finance)         — independent
AB2 (codex agentic)   — needs ChatGPT Plus purchased + codex CLI installed
```

Recommended: **AB1 → AF → AD → AC → AE → AB2** (AB2 floats to whenever Plus
is bought; nothing else blocks on it).

## 5. Execution rules (unchanged from master plan §6)

Additive migration-safe schema; backward-compatible API shapes; stable WS
types; secrets server-side + gitignored; every phase ends with
`test:server`, `test:client` (snapshot diffs reviewed, never blind `-u`),
`/verify` on the live app for UI phases, docs via `update-project-docs`.
New pollers/watchers fail-safe. Chart work reads `dataviz` first.

## 6. Explicitly NOT doing (so future sessions don't re-litigate)

- GPT chat/image adapters without an API key (Plus doesn't grant one).
- Any wrapper around the ChatGPT app / ChatGPT Work (no API, ToS risk).
- WebRTC/VNC screen mirroring inside the PWA (RustDesk is strictly better).
- Bank/Plaid/open-banking integrations (manual + paste-parse only).
- A new todo database (notes markdown is the todo store; Monday is Monday).
- Rebuilding scheduled cloud agents for GPT (ChatGPT Work does this natively;
  Jarvis's Phase-L scheduler stays for Claude/local).
- Rebuilding or wrapping Claude Dispatch (native phone→desktop trigger for
  Cowork; the dashboard's phone-spawn stays for the gated/multi-provider
  cases — see decisions table).

---

*End of plan. Each phase names its verification gate; a phase is not done
until its gate passes on-device where applicable.*
