# PLAN: Jarvis Master — from subagent dashboard to one-stop Jarvis system

Written 2026-07-03 after a reverse-prompt session with the user. Execute phases in
separate fresh sessions (Opus), one phase per session unless noted. Every session
MUST read `CLAUDE.md`, `.claude/rules/*`, and `ARCHITECTURE.md` first — the
non-negotiables (minimal reversible diffs, backward-compatible API shapes,
non-blocking hooks, never weaken safety controls, docs updated in the same
change-set) apply to every phase below.

---

## 1. Vision

One dashboard — desktop view, mobile remote view, installable phone app, push
notifier, and voice endpoint — all the **same codebase and same server**,
reachable from anywhere over Tailscale. On top of the existing Claude Code
monitoring/spawning core, add: a multi-provider AI harness (Gemini, Ollama,
Claude; GPT slot reserved), a Projects system, a Notes system with a
"mini-Jarvis" brain that reformats brain dumps and tracks what the user is
working on / neglecting / finished, a tappable Skills automation system, and
work panels (dev workflow, calendar/email, system health). Jarvis speaks and
listens in the car via Siri Shortcuts hitting the dashboard API.

### Decisions locked with the user (do not re-litigate)

| Decision | Choice |
|---|---|
| Phase 3 of `PLAN-interactive-permissions-and-screenshots.md` | NOT done; it is execution item #1 here (Phase A) |
| Remote access | **Tailscale** (free personal plan). No same-WiFi requirement — works over cellular incl. CarPlay |
| Mobile app | **PWA of this dashboard itself** — no separate app. Installed to home screen; iOS 16.4+ web push |
| Voice/CarPlay | **Siri Shortcuts** calling dashboard API over Tailscale (dictate → POST → Speak reply). No native app |
| Mini-Jarvis brain | **Tiered router: Gemini API free tier (default) → Claude headless `claude -p` (complex) → Ollama (simple + fallback)**. Ollama runs on the user's 24/7 work PC, reached over Tailscale |
| Notes storage | **Markdown files on disk + SQLite index** (Obsidian-compatible, agent-readable) |
| Providers | User has: Gemini Pro plan, ChatGPT **free** (no API — see constraints), can set up Ollama on work PC. Wants image/video gen (Gemini can; GPT deferred) |
| Work domains | Dev workflow (GitHub/CI), Calendar/email/tasks, System/homelab health |
| Skills scope | Dev/agent chores, computer automation (shell/AppleScript), daily briefings, phone-side actions (via Shortcuts) |

### Honest constraints (surface these, don't work around them)

- **ChatGPT free has no API.** Do not build unofficial wrappers (ToS violation,
  account bans). The chat UI must be provider-pluggable so an OpenAI key slots
  in later; until then GPT/DALL·E/Sora are absent from the harness.
- **A real CarPlay app is impossible for free** (entitlement + paid dev
  account). Siri-via-Shortcuts is the CarPlay story and it is genuinely good:
  hands-free two-way voice, and pushed notifications announced by Siri
  ("Announce Notifications" must be enabled for the PWA — verify this works
  with web-push notifications during Phase C; if iOS won't announce web push,
  fall back to also shipping an ntfy topic as the announced channel).
- **iOS web push caveats**: only fires for PWAs *installed to home screen*
  (iOS 16.4+); **no inline action buttons** on iOS web push — Allow/Deny from
  a notification means tap → PWA opens deep-linked to the request, then tap
  Allow. Two taps, not one. Acceptable; do not fake it.
- **The Mac must stay awake** for the server, spawned runs, and `claude -p`
  brain calls. Document `caffeinate -s` / Amphetamine / `pmset` in SETUP.md
  (Phase C). The work-PC Ollama node covers brain fallback when the Mac
  sleeps, but the dashboard itself is Mac-hosted — if the Mac is asleep,
  Jarvis is down. (A later stretch: move the server to the 24/7 work PC.)
- **Gemini free-tier rate limits** are real (requests/day per model). The
  brain router must degrade to Ollama gracefully on 429s, never queue-and-hang.

---

## 2. Current state (verified in code 2026-07-03 — don't re-derive)

- **Interactive permissions**: server side fully shipped and tested —
  `scripts/permission-gate.js`, pending store + `permission_request` /
  `permission_resolved` broadcasts in `server/lib/run-spawner.js`
  (lines ~582–636), endpoints in `server/routes/run.js` (~325–400):
  `POST /api/run` accepts `permissionUx:"interactive"`;
  `GET /api/run/:id/permissions`; `POST /api/run/:id/permission/request`
  (hook); `GET|POST /api/run/:id/permission/request/:requestId`.
  Tests in `server/__tests__/run.test.js`. **Client has zero permission UI**
  (grep for `permission_request|PermissionRequest|permissionUx` in
  `client/src` returns nothing).
- **Web push already shipped**: `server/lib/push.js` (VAPID keys persisted in
  data dir, `web-push` lib, subscription cleanup, Electron-native fallback),
  `server/routes/push.js`, `client/public/manifest.json`, `client/public/sw.js`,
  manifest linked from `client/index.html`. Phases C/J extend this — do not
  rebuild it.
- **Home page**: `client/src/pages/Dashboard.tsx` (1594 lines) — "command
  bridge" of 5 `HoloStat` floating tabs + `SessionWindowStat` ("SESSION RESETS
  IN", line ~1319) flanking `JarvisCore` (which wraps `CoreSphere3D`), then a
  2-col grid of Active-agents / second panel, with a Monitor/Health tab
  switcher. The "timer" the user dislikes as a flat tab = `SessionWindowStat`,
  fed by `stats.session_window` from `/api/stats` (usage-poller).
- **Mobile**: `Layout.tsx` has `useIsMobile`, hamburger + slide-in `Sidebar`,
  desktop-only `Tabby` widget. Pages are responsive-ish but the Dashboard on
  mobile is a long scroll of stat tabs — exactly the user's complaint.
- **Conversation rendering**: `client/src/components/conversation/`
  (`ConversationView`, `MessageList`, `ToolCallBlock`, image rendering from
  the screenshots slice). `SteerPanel.tsx` (172 lines) exists on the Run page.
- **Server**: Express routes in `server/routes/` (16 files incl. `push.js`,
  `alerts.js`, `webhooks.js`, `workflows.js`), SQLite, WS broadcast, run
  spawner with envelope replay (`MAX_ENVELOPES_PER_HANDLE = 500`),
  `usage-poller.js`, `token-usage.js`, `cc-discovery/watcher/mutate`.
- Repo is the CCAM fork living at `jarvis-dashboard/app` (see memory:
  jarvis-dashboard-fork-decision). Dev against a sandboxed `CLAUDE_HOME`.

---

## 3. Cross-cutting architecture additions

These are shared foundations several phases depend on. Build each inside the
phase that first needs it (marked), but design them per this section so later
phases don't refactor.

### 3.1 Provider adapter layer (first needed: Phase E)

`server/lib/providers/` with one module per provider implementing a common
interface, two capability classes:

- **`chat(messages, opts) → stream`** — plain chat completion streaming.
  Implementations: `gemini.js` (`@google/genai`, free-tier API key; also
  `generateImage` via the current Gemini image model — check the live model id
  at build time via `claude-api` skill / docs, do not hardcode from memory),
  `ollama.js` (HTTP to `http://<work-pc-tailscale-name>:11434`, model list
  from `/api/tags`), `claude.js` (spawn `claude -p --output-format
  stream-json`, session-id continuation for multi-turn).
- **`spawnAgent(prompt, opts) → handle`** — agentic run with tool use,
  streamed envelopes. Today only Claude (`run-spawner.js`). Phase E
  generalizes: extract the provider-specific spawn/parse bits behind an
  adapter so `gemini-cli` (user's Gemini Pro plan raises its limits) can be a
  second agentic backend. **Do not rewrite run-spawner**; wrap it — the
  Claude path must keep byte-identical behavior (existing tests prove it).

Config: `server/config/providers.json` (gitignored) + Settings-page UI for
keys/hosts. Never put keys in the client bundle; all provider calls are
server-side.

### 3.2 Mini-Jarvis brain (first needed: Phase G, used by D, H, J)

`server/lib/brain/` — a task router, not a chatbot:

- `route(task) → provider`: task classes `simple` (tag extraction, yes/no
  triage) → Ollama; `standard` (brain-dump reformatting, briefing
  composition, notification copy) → Gemini flash; `complex` (multi-note
  synthesis, "what am I neglecting" judgment, planning) → `claude -p`.
  Fallback chain on error/429: gemini → ollama → claude (configurable).
- Every brain call is logged to a `brain_calls` table (task class, provider,
  latency, tokens if available) — visibility on the Analytics page later.
- Brain context = the Notes/Projects SQLite index + recent dashboard activity
  (sessions, runs, skills executed). Context assembly is a pure function with
  a token budget; test it with fixtures.
- System prompt lives in `server/lib/brain/prompts/` as versioned .md files.

### 3.3 Assistant endpoint (first needed: Phase D)

`POST /api/assistant/ask` `{text, source: "siri"|"chat"|"notes", speak?: bool}`
→ routes through the brain, returns `{text, speech}` where `speech` is a
short spoken-style variant (Siri reads it). Same-origin guard exempted for
this route is NOT acceptable — instead issue a long-lived bearer token
(Settings page generates it; Shortcut stores it) checked by middleware.
Rate-limit it. This one endpoint powers Siri, CarPlay, the notes chat, and
quick actions.

### 3.4 Mobile information architecture (first needed: Phase B)

One responsive app, but mobile gets a distinct shell: bottom tab bar
(Home / Agents / Chat / Notes / Skills) instead of the hamburger sidebar,
swipeable card stacks instead of stacked panels. Desktop keeps the sidebar.
Implement as layout-level branching on `useIsMobile` (pattern already exists
in `Layout.tsx`), not separate routes — same pages, different chrome.

---

## 4. Phases

Ordering rationale: A is contracted debt with zero unknowns; B delivers the
visible redesign early; C unlocks *everything* mobile (D, H-phone, J depend on
it); E–H build the new product surface in dependency order (providers → chat →
projects/notes/brain → skills); I and J compose what exists.

### Phase A — Finish interactive permissions UI (Phase 3 of the old plan)

*One session. No unknowns; server contract is live and tested.*

1. New `client/src/components/PermissionRequests.tsx` rendered inside the Run
   page near `SteerPanel.tsx`: lists pending requests (tool name, input
   preview using existing `ToolCallBlock` styling), Allow / Deny buttons →
   `POST /api/run/:id/permission/request/:requestId` `{decision}`.
2. State: seed from `GET /api/run/:id/permissions` on mount/reconnect, then
   live-update from `permission_request` / `permission_resolved` WS messages
   (extend `useWebSocket.ts` handler map). Must degrade safely on WS
   disconnect per `.claude/rules/frontend-react.md` — poll the GET on a
   visible "reconnecting" state.
3. Spawn form (Run page) gets a "Interactive permissions" toggle →
   `permissionUx:"interactive"` on `POST /api/run`.
4. A pending request must be loud: pulse the Run row/status, fire the existing
   web-push path (`server/lib/push.js`) with a deep link
   `/run/:id#permission-:requestId` — this is the first producer of
   action-needed pushes and sets the pattern Phases C/J reuse.
5. Verify per `CLAUDE.md`: `npm run test:server`, `npm run test:client`
   (snapshot regen reviewed, never blind `-u`), then `/verify` driving a real
   interactive run end-to-end in the browser. Update SETUP/ARCHITECTURE/README
   (hook table + endpoints already documented server-side; add the UI story).

### Phase B — Home page redesign: graphical, fewer tabs, mobile-first

**Status: Implemented (2026-07-03).** `HoloGauge`/`HoloSpark`/`HoloOrbit` (new,
siblings of `HoloStat`) replaced the six flat stat tiles; the session-reset
countdown became a depleting arc + ticking digits on `JarvisCore` itself
(`sessionWindow` prop) instead of a `SessionWindowStat` tile; Active-agents +
Recent-activity merged into one "Operations" holo-panel with an internal
Operations/Health segmented control (was page-level tabs); mobile gets a 2×2
instrument grid under the core plus a bottom tab bar (`MobileTabBar.tsx`,
Home/Agent Board/Sessions/Activity/More) replacing the hamburger drawer.
Not yet done: snapshot-test regeneration and on-device mobile verification
(deferred per this session's explicit scope — typecheck-only, no dev server).

*One to two sessions. Read the `dataviz` skill BEFORE writing any chart/gauge
code — it has the palette validator and mark specs; reuse `--chart-*` tokens
and holo-panel classes from `index.css`, no hand-rolled colors.*

Design intent (from the user): keep the animated holographic philosophy, show
information **graphically instead of as floating tabs**, fewer panels overall
since detail lives in subpages; mobile must not be a scroll of tabs.

1. **Session-reset countdown becomes a real countdown**: replace
   `SessionWindowStat` (Dashboard.tsx ~1319) with a radial arc gauge —
   an animated ring segment that visibly depletes across the 5-hour window,
   digits ticking each second (client-side tick from `session_window`
   timestamps; no polling change), color shifting via existing status tokens
   as it nears reset. Candidate placement: an arc *around* `JarvisCore`
   itself, making the core the clock — strongest thematic fit; fall back to a
   standalone gauge beside it if the core composition gets crowded.
2. **Stat tabs → instrument cluster**: the six `HoloStat`s become compact
   graphical instruments: events/min → live sparkline; cost → dial with
   today-vs-week reference; active agents/subagents → orbiting dots around a
   count (working=animated, waiting=amber pulse); total sessions →
   number + 7-day sparkline. Keep the `holo-boot` staggered animation.
   Build as new `HoloGauge`/`HoloSpark` siblings of `HoloStat` — don't break
   `HoloStat` users elsewhere.
3. **Panel consolidation**: merge Active-agents + alerts/waiting into one
   "Operations" feed panel (agent tree rows with inline waiting badges and
   quick actions from `AgentQuickActions`); Monitor/Health becomes a
   segmented control inside the single lower panel, not page-level tabs.
4. **Mobile home**: instrument cluster collapses to a 2×2 grid of mini
   gauges + the core with its countdown ring at top; Operations feed below;
   bottom tab bar shell per §3.4. `Tabby` stays desktop-only.
5. Snapshot tests will churn: review every diff deliberately
   (`screens.snapshot.test.tsx` covers Dashboard). Update docs/screenshots
   refs per `update-project-docs`.

### Phase C — Remote access, PWA install, push hardening

**Status: Implemented (2026-07-04, code + docs only).** PWA rebranded to **Jarvis**
(`client/public/manifest.json` id/name/short_name/description, `theme_color`
`#00c2e8`, `background_color` `#0f1117`; `apple-mobile-web-app-title` + `mobile-web-app-capable`
metas added to `client/index.html`). `sw.js` already handled `push` +
`notificationclick` deep-link routing (Phase A) — left as-is. **Server-side push
categories** shipped: new `notification_prefs` table (`server/db.js`), `PUSH_CATEGORIES` +
`isCategoryEnabled` + a `category` gate on `sendPushToAll` (`server/lib/push.js`),
`GET /api/push/categories` + `PUT /api/push/categories/:category` (`server/routes/push.js`,
OpenAPI fragments added), run-spawner tags permission pushes `permission_requests`.
Settings → Notifications gained an all-devices "Push categories" card
(`client/src/pages/Settings.tsx` + `client/src/lib/push.ts` + en locale). SETUP.md
documents the iOS PWA-over-tailnet-HTTPS requirement (`tailscale serve`), keep-awake
(`caffeinate`), and the categories; ARCHITECTURE/README updated. **Not done** (deferred
per this session's explicit scope — typecheck-only, no dev server): on-device iPhone
verification (steps 1 & 4 — SW registration over tailnet HTTPS, cellular push receipt,
Siri "Announce Notifications"; the `ntfy` fallback stays unbuilt until that test says it's needed).

*One session, half of it verification on a real iPhone.*

1. **Tailscale**: no code — SETUP.md gains a "Remote access" section: install
   on Mac + iPhone, MagicDNS name (e.g. `http://macbook.tailnet-name.ts.net:4000`),
   note that HTTPS via `tailscale cert` (or `tailscale serve`) is REQUIRED for
   iOS to register the service worker + web push on a non-localhost origin —
   this is the one sharp edge; verify sw registration over the tailnet URL
   explicitly. Also document keeping the Mac awake (`caffeinate -s`, or the
   existing `npm start` under a LaunchAgent).
2. **PWA polish**: audit `manifest.json` (name → Jarvis, theme colors from
   the holo palette, maskable icons, `display: standalone`); ensure `sw.js`
   handles `push` + `notificationclick` with deep-link routing (Phase A's
   permission deep links must open correctly from a notification tap).
3. **Push subscription UX**: Settings page card — enable-notifications button
   (existing `routes/push.js`), per-category toggles stored server-side
   (permission requests / run completions / waiting agents / briefings) so
   Phase J doesn't spam.
4. **Verify on-device**: install PWA over tailnet HTTPS, background the
   phone, trigger a permission request, receive push on cellular
   (WiFi OFF — this is the user's explicit acceptance test), tap → lands on
   the request. Test Siri "Announce Notifications" for the PWA in the car or
   with a Bluetooth device; record the result in SETUP.md (if iOS won't
   announce web push, add an `ntfy` publish alongside `sendToAll` in
   `push.js` as the announced channel — small, optional, behind a setting).

### Phase K — Multi-account tracking (claude-swap)

**Status: Implemented (2026-07-04, code + docs only).** Additive schema:
`accounts` + `account_swaps` tables and nullable `account_id` columns on
`sessions` and `dashboard_runs` (`server/db.js`, all migration-safe). New
read-only observer `server/lib/claude-swap.js` watches
`~/.claude-swap-backup/autoswitch_state.json` (fs.watch + a 60s safety poll),
defensively parses the active account + known accounts, upserts them, records a
row in `account_swaps` on every active-account transition, broadcasts
`account_swapped`, and fires an `account_swaps`-category push. `getActiveAccountId()`
tags each dashboard run at spawn time (`dashboard-runs.js`); `getAccountsState()`
backs `GET /api/accounts` (`server/routes/accounts.js`). Fully fail-safe: with no
claude-swap present everything stays empty and single-account setups are
unchanged. UI: `client/src/components/AccountsStrip.tsx` under the JarvisCore
shows the active account badge + each other account's reset time, self-hiding
when `present:false`. Overrides: `CLAUDE_SWAP_BACKUP_DIR`, `CLAUDE_SWAP_POLL_MS`.
**Not done** (deferred per this session's typecheck-only scope — no dev server,
no on-device test): forcing a real swap end-to-end (step 6), and per-account
window/reset accuracy depends on what claude-swap actually writes to its state
file (parsed best-effort; unknown resets render as absent, not guessed). Session
attribution beyond the `account_id` column (step 4) is left best-effort — the
column exists and runs are tagged; straddling sessions are not back-attributed.

*One session. Independent — needs nothing from other phases; slotted right
after C in execution order. (Lettered K, not renumbered, so existing D–J
references stay valid.)*

Context: the user runs **two Claude accounts** via
[claude-swap](https://github.com/realiti4/claude-swap) with **auto-swap
already configured**. The dashboard must track both accounts as one unified
view: which account is active, each account's session window / usage, and
swap events.

1. **How claude-swap works** (verified against the repo README 2026-07-04;
   re-verify layout on the user's machine at build time): it swaps accounts
   *in place* — sessions keep using the normal `~/.claude`; credentials on
   macOS live in the **Keychain** (not files — do not try to watch or read
   them). Its own state lives under **`~/.claude-swap-backup/`**: per-account
   backups, `settings.json`, and **`autoswitch_state.json`** (auto-switch
   state), with per-account session profiles under `sessions/`. Auto-swap is
   *proactive*: at ~90% quota it switches to the account with the most quota
   left (5-min cooldown; sleeps until earliest reset when all are exhausted).
   The integration must be read-only: the dashboard observes claude-swap's
   state files, it never performs swaps itself (v1). Document the actual
   layout found in ARCHITECTURE.md.
2. **Account-aware usage tracking**: extend `usage-poller.js` /
   `token-usage.js` to tag every sample with an account identity (additive
   `accounts` table + nullable `account_id` columns, migration-safe). Detect
   the active account + swap moments via a chokidar watcher (pattern exists
   in `cc-watcher.js`) on `~/.claude-swap-backup/autoswitch_state.json`;
   record a swap-history table. Fail-safe: if claude-swap is absent,
   everything behaves exactly as today (single implicit account) — zero
   regression for non-swap setups.
3. **UI**: the JarvisCore session-window ring (Phase B) shows the *active*
   account's window with an account badge; a compact secondary indicator
   shows the other account's window/reset time ("Acct 2 resets 3:40pm").
   Sessions/usage/analytics views get an account filter or badge. Swap
   events appear in the activity/Operations feed.
4. **Attribution**: sessions and runs are tagged with the account active at
   their start time (best-effort — state it as such in the UI, don't imply
   certainty for sessions that straddled a swap).
5. Optional push category (extends C3 toggles): "auto-swapped to account 2 —
   account 1 resets at HH:MM".
6. Verify: force a swap (hit a limit or trigger claude-swap manually), watch
   the dashboard flip active account, both countdown windows stay correct,
   and history/attribution record it. `npm run test:server`.

### Phase L — Scheduled & chained prompts

**Status: Implemented (2026-07-04, code + docs only).** Additive
`scheduled_prompts` table (`server/db.js`) captures prompt, target
(`new_run` with JSON spawn opts | `session_message` with a runId), trigger
(`at` timestamp | `on_run_complete` run-id + `status_filter`), status, chain
depth, `late`, `fired_at`, `result_run_id`, error. `server/lib/scheduler.js`
is THE shared, generic scheduler (a `registerDueCallback(kind, fn)` registry so
G2/H5 reuse it): re-arms pending `at` schedules from SQLite on boot (a missed
time fires immediately with `late`), fires completion triggers off a new
`onRunStatus` subscription added to `run-spawner.js` (driven, not polled),
interpolates `{status}`/`{exitCode}`/`{runId}` into follow-up prompts, spawns
`new_run` targets through the normal spawn path, guards a max chain depth, and
supports cancel-cascade. Every fire/failure emits a `schedule_*` WS event + an
optional `scheduled_prompts`-category push. REST CRUD at `/api/schedules`
(`server/routes/schedules.js`, reusing the Run router's loopback-Origin guard).
UI: a new `Scheduled` page (`client/src/pages/Scheduled.tsx`, route `/scheduled`
+ sidebar nav) lists/creates/cancels schedules for both trigger kinds, and the
Run page grew an inline **Queue follow-up** action. All always-on work is
fail-safe (a scheduler crash never takes down the server or the watched run).
**Not done** (deferred per this session's typecheck-only scope — no dev server):
the on-device firing/restart-survival walk-through (step 7). `on_run_complete`
schedules whose watched run finished while the server was down will not
retro-fire (documented behaviour).

*One session for the core; voice/brain integration lands later with D/G2.
Independent — uses only the existing run lifecycle; slotted right after
C/K in execution order.*

Context (user's own example): a session is implementing part 3 of a plan;
the user schedules — or tells mini-Jarvis — "run part 4 after part 3
completes". Two trigger kinds: **at a time** and **on completion of a
currently running task**.

1. **Schema** (additive): `scheduled_prompts` — id, prompt (template),
   target (`new_run` + spawn opts captured at schedule time: cwd, project,
   permissionUx, provider | `session_message` + run/session id, delivered
   via the existing `/api/run/:id/message` redirect), trigger
   (`at` timestamp | `on_run_complete` run-id + status filter
   success/any), status (pending/fired/cancelled/failed), fired_at,
   result_run_id.
2. **Scheduler**: `server/lib/scheduler.js` — persistent across restarts
   (re-arm pending schedules on boot from SQLite; a missed `at` time fires
   immediately with a "late" flag). Time triggers via node-cron/timeouts;
   completion triggers hook the run status transitions in `run-spawner.js`
   — non-blocking and fail-safe per repo rules (a scheduler crash must
   never take down the server or the run it was watching). **This becomes
   THE shared scheduler** that G2 (daily brain task) and H5 (skill cron)
   reuse — build it generic (a `due(job)` callback registry), not
   prompt-specific.
3. **Firing**: `new_run` targets POST through the existing spawn path (so
   permission gating, envelopes, WS broadcasts all apply — nothing
   bespoke); `on_run_complete` prompts may interpolate the completed run's
   final status/summary into the prompt template ("Part 3 finished:
   {status}. Now implement part 4 …"). Fire and failure both emit a WS
   event + optional push (C3 category "scheduled prompts").
4. **Chaining**: the run created by a fired schedule can itself be the
   trigger of another pending schedule — queue part 4, 5, 6 up front.
   Guard with a max chain depth and cancel-cascade (cancelling a schedule
   cancels its dependents, with confirmation).
5. **UI**: Run page gets a "Queue follow-up" action (prompt box + fire-on:
   complete/success-only); spawn form gets "run after <existing run>";
   a Scheduled panel (Runs page or its own card) lists pending/fired with
   cancel/edit. Pending follow-ups show as a badge on the parent run row.
6. **Later integration (marked here, built in those phases)**: Phase D
   intent "after run X finishes, do Y" → creates a schedule via this API;
   Phase H skill `agent` steps and H5 cron reuse the scheduler; mini-Jarvis
   (G2) can propose follow-ups. Keep the REST surface
   (`/api/schedules` CRUD) stable for them.
7. Verify: schedule an at-time prompt and watch it fire; attach a follow-up
   to a live run and confirm it fires only on completion (and respects a
   success-only filter on a killed run); restart the server with pending
   schedules and confirm they survive. `npm run test:server`,
   `npm run test:client` for the new UI.

### Phase D — Voice: Siri Shortcuts + CarPlay two-way

**Status: Implemented (2026-07-04, code + docs only).** `POST /api/assistant/ask`
(`server/routes/assistant.js`) returns `{ text, speech }` — `speech` shaped by
`server/lib/brain/speech.js` (no markdown, ≤2 sentences, rounded numbers). Auth is
a scoped, revocable **assistant bearer token** (`server/lib/assistant-token.js`,
SHA-256-hashed in the new `assistant_tokens` table, shown once), checked by
`assistantAuthGuard`; the route is exempted from the `DASHBOARD_TOKEN` gate
(`TOKEN_EXEMPT_PREFIXES` in `server/lib/security.js`) so a Shortcut carries ONLY
that token, yet is never open (a no-Origin caller must present it). Token-admin
routes (`GET/POST/DELETE /api/assistant/tokens`) stay behind `DASHBOARD_TOKEN` + a
reused loopback same-origin guard. Rate limited per token (`ASSISTANT_RATE_LIMIT`).
Deterministic intent prelude (`server/lib/assistant.js`): `status` (run-spawner +
SQLite), `kill`/`steer` (run-spawner), `note:` (captured to the new
`assistant_captures` inbox for Phase G to drain), `run skill` (Phase H stub);
everything else → the `server/lib/brain` router — a **stub** (no provider calls;
honest reply) with a real `classify()` + bounded multi-turn buffer, stable-contract
so G2 replaces only its body. UI: a **Settings → Voice & Siri** card
(`client/src/pages/Settings.tsx` + `api.ts` + en locale) generates/lists/revokes
tokens and has a query tester. Docs: SETUP.md Shortcut recipe + host-allowlist note,
`docs/jarvis-siri-shortcut.md` recipe spec, ARCHITECTURE/README/docs/API updated.
**Not done** (deferred per this session's typecheck-only scope — no dev server, no
device): the on-device voice round-trip over cellular / CarPlay (step 4),
`npm run test:server`, and client snapshot regeneration (the Settings snapshot
churns from the new Voice card — its api mock was extended so the suite doesn't
throw, but the baseline is left for a deliberate review pass). A signed
`.shortcut` binary can only be exported on-device (Apple signs per-account), so
the repo ships the recipe, not a binary.

*One session server-side + a documented Shortcut recipe. Depends on C (token
+ tailnet HTTPS) and G's brain for good answers, but ship it against a
minimal brain stub if G isn't done — the endpoint contract (§3.3) is stable.*

1. Implement `POST /api/assistant/ask` per §3.3 (bearer token middleware,
   rate limit, `{text, speech}` response; `speech` capped ~2 sentences,
   numbers rounded, no markdown).
2. Add intent handling for the high-value voice queries before general chat:
   "status" (active agents/runs/waiting), "kill/steer <run>", "note: <dump>"
   (→ Phase G inbox), "run skill <name>" (→ Phase H). Simple keyword prelude
   in front of the brain call; deterministic where possible.
3. **Shortcut recipe** (documented step-by-step in SETUP.md, exported
   .shortcut file in `docs/`): "Jarvis" → Dictate Text → Get Contents of URL
   (POST, bearer header, tailnet URL) → Get `speech` from JSON → Speak Text →
   optional "Ask for input: reply?" loop for multi-turn (pass a
   `conversationId` the endpoint accepts for context continuity).
   In CarPlay this whole loop is hands-free via "Hey Siri, Jarvis".
4. Verify: full voice round-trip on iPhone over cellular; from CarPlay if
   available. `npm run test:server` for the new route.

### Phase E — Multi-provider AI harness

**Status: Implemented (2026-07-04, code + docs only — E1 + E2 in one session).**
**E1 (chat):** provider layer `server/lib/providers/` — `config.js` (gitignored
`server/config/providers.json` + `providers.example.json`, env fallbacks
`GEMINI_API_KEY`/`OLLAMA_HOST`/`OPENAI_API_KEY`, redacted client view), chat
adapters `gemini.js` (REST + `fetch` streaming, dependency-free instead of
`@google/genai`; also `generateImage`), `ollama.js` (live `/api/tags` models),
`claude.js` (headless `claude -p` stream, `--resume` continuation), and
`index.js` registry with the inert GPT slot. Additive `chats`/`chat_messages`
tables (`server/db.js`). Routes `server/routes/chat.js`: providers/config CRUD +
conversation CRUD + **SSE** streaming completion + Gemini image gen/serve. New
**Chat page** (`client/src/pages/Chat.tsx`, route `/chat` + sidebar nav +
`nav:chat` locale) with provider/model picker, streaming markdown transcript
(reuses `MarkdownContent`), saved chats, inline image gen. **Settings → AI
Providers** card manages the Gemini key / Ollama host / GPT slot via
`GET/PUT /api/chat/config` (redacted). **E2 (agentic):** `server/lib/providers/agent/`
(`claude.js`, `gemini-cli.js`, `gemini-stream-parser.js` sibling of
`stream-json-parser.js`); `run-spawner.js` threads a `provider` field — the
**Claude path is byte-identical** (proven by the unchanged `run.test.js`) and
only a non-Claude provider swaps the adapter's command/argv/parser. `gemini-cli`
is headless with **no permission gate**; `GET /api/run/providers` + a Run
spawn-form provider picker (interactive toggle disabled for non-Claude).
Tests: `server/__tests__/providers.test.js` + `chat.test.js` (581 server tests
pass); client typecheck + snapshot (Settings baseline regenerated deliberately,
new Chat snapshot). Docs: ARCHITECTURE/README/SETUP/API/DATABASE/.env.example +
OpenAPI fragment. **Not done** (deferred — typecheck-only scope, no dev server,
no keys/Ollama/`gemini` CLI available): live provider round-trips (chat with all
three, image gen, a Gemini-CLI run beside a Claude run — step 5). The Gemini
model ids and the `gemini` CLI argv/stream schema are best-effort defaults that
**must be verified** against the live models/CLI at first use (both are
config/env-overridable so no code change is needed to correct them). Video gen:
left as a disabled affordance — the plan's usable-quota check couldn't run here.
VN/CN READMEs + wiki i18n intentionally not mirrored this pass (English core
only, matching prior phase notes).

*Two sessions: (1) provider layer + chat UI, (2) Gemini CLI agentic runs.*

Session E1 — chat:
1. Build `server/lib/providers/` per §3.1 (gemini/ollama/claude chat
   adapters), `server/config/providers.json` + Settings UI for the Gemini
   key and Ollama host (default to the work PC's tailnet name).
2. New **Chat page**: provider/model picker, streaming markdown transcript
   (reuse `MarkdownContent`/`CodeBlock`), conversation persistence in SQLite
   (`chats`, `chat_messages` tables — migration-safe additive schema),
   image-generation action for Gemini models that support it, generated
   images stored under the data dir and rendered inline (reuse the
   screenshot lightbox from the conversation components). Video gen: expose
   only if the user's Gemini plan surfaces a usable API/quota — check at
   build time, otherwise leave a disabled affordance with an honest tooltip.
3. GPT: render the provider slot with "needs OpenAI API key" state. Nothing
   else — see constraints.

Session E2 — agentic:
4. Wrap run-spawner behind a provider adapter (§3.1) and add `gemini-cli`
   as a spawnable agentic backend: spawn, parse its stream format into the
   existing envelope shape (write a `stream-parser` sibling to
   `stream-json-parser.js`), status lifecycle, kill. Run page grows a
   provider picker on the spawn form. Claude behavior must remain
   byte-identical (existing `run.test.js` + new adapter tests prove it).
   Gemini runs get no permission-gate claims — the PreToolUse gate is
   Claude-only; the UI must not imply otherwise.
5. Verify: chat with all three providers, generate an image, spawn a Gemini
   CLI run and a Claude run side by side. `test:server`, `test:client`,
   mcp typecheck untouched unless MCP tools were added.

### Phase F — Projects

**Status: Implemented (2026-07-04, code + docs).** Additive schema: `projects`
(id, name, description, status active/paused/done, repo_path?, notes_dir?,
created/updated) + `project_paths` (one-to-many — a project may span repos),
plus nullable `project_id` on `sessions` / `dashboard_runs` / `chats`
(`server/db.js`). New `server/lib/projects.js`: CRUD, `matchProjectForCwd`
(longest-matching-prefix, path-boundary aware), `resolveProjectId` (explicit
id wins over cwd match), `associateSessionByCwd` / `associateRunByCwd`
(best-effort, never throw), `rescanUnassociated()` (retroactive backfill run
whenever a path is added), and `getProjectRollup` (counts + recent items +
last activity). New `server/routes/projects.js` at `/api/projects` (plain
CRUD, no process-spawning, so only the global host/CORS/token guard applies —
same posture as `alerts.js`/`webhooks.js`). Auto-association wiring:
`hooks.js` tags a new session right after creation; `run-spawner.js` resolves
the project once at spawn time (explicit `projectId` on `POST /api/run` wins,
else cwd match) and stores it on the live handle, `dashboard-runs.js`
persists it. Chats have no cwd, so `chats.project_id` is explicit-only via an
optional `projectId` on `POST`/`PATCH /api/chat/chats/:id` (no Chat-page UI
yet). Deleting a project un-tags (never deletes) its sessions/runs/chats.
New OpenAPI fragment `server/openapi-extra/projects.js`. Client: `Projects.tsx`
(card grid, status filter, create) + `ProjectDetail.tsx` (edit/status/delete,
repo-path management with backfill, aggregated activity feed) at `/projects`
and `/projects/:id`; Sidebar nav entry (reachable on mobile via "More", no
dedicated bottom-tab slot — same as Chat/Scheduled/Settings). Docs updated:
README feature table + API.md + ARCHITECTURE.md (ERD + a Projects prose
subsection + routing table) + DATABASE.md; VN/CN READMEs, `index.html`, and
the wiki were intentionally **not** mirrored, matching the precedent set by
Phases D/E/K/L. Tests: new `server/__tests__/projects.test.js` (21 tests: route CRUD, path
add/remove with retroactive backfill, cwd longest-prefix matching incl. the
nested/sibling-path edge cases, hook-ingested session auto-association,
dashboard-run tagging via `dashboard-runs.js`, and the chat `projectId`
field) — `npm run test:server` now 602 pass (was 581). Client suite (248
pass + typecheck) green, zero snapshot changes needed (Projects isn't part
of `screens.snapshot.test.tsx`). **Deviation from the plan text**:
there is no separate globally-toggled "active project" concept (unlike Phase
K's claude-swap "active account") — a dashboard-spawned run is tagged the
same way a hook-ingested session is, by matching its `cwd` against
`project_paths`, with an optional explicit `projectId` override on
`POST /api/run` for a project-scoped spawn action that doesn't exist in the
UI yet. **Verified live**: dev server started against an isolated
`DASHBOARD_DATA_DIR` scratch DB (never touching the user's real dashboard
data — the default port/DB was already in use by another running instance)
and driven with Playwright against system Chrome: created a project, edited
description, toggled status (Paused, confirmed it survives a reload), added
a second repo path, deleted the project (confirmed it disappears from the
list and un-tags rather than errors), zero browser console errors. Screens
captured for both the card-grid list and the detail view.

*One session. Independent of E; can run before it.*

1. Schema: `projects` (id, name, description, status
   active/paused/done, repo_path?, notes_dir?, created/updated),
   plus nullable `project_id` columns added migration-safe to sessions-,
   runs-, chats-, notes-, skills-related tables as those exist.
2. Projects page: card grid (holo panels) with per-project rollups — linked
   sessions/runs, recent notes, open items; create/edit/archive. A project
   detail view aggregates its activity feed.
3. Auto-association: dashboard-spawned runs tag the active project;
   hook-ingested sessions map by cwd → `repo_path` prefix match (a
   `project_paths` table, since one project may span repos).
4. This is deliberately *separate from Claude projects* (user requirement) —
   it's the organizing dimension of the whole dashboard; mini-Jarvis reads it.

### Phase G — Notes + mini-Jarvis brain

**Status: Implemented (2026-07-04, G1 + G2 in one session; code + docs, verified
live).** **G1 (notes):** notes are markdown files on disk (default `~/JarvisNotes`,
override via `JARVIS_NOTES_DIR` env or the `app_settings` KV table, editable from
the Notes page) with YAML frontmatter (id/title/tags/project/created/updated/
source + verbatim `original` for dumps). `server/lib/notes.js` owns a
dependency-free frontmatter parser/serializer, the file store (create/update/
delete), a rebuildable SQLite index (`notes` table) + **FTS5** (`notes_fts`,
guarded — degrades to a LIKE scan on a stripped SQLite via `NOTES_FTS_OK`), and an
`fs.watch` watcher (same primitive as `cc-watcher.js`, not chokidar) that
reindexes live on any on-disk edit and broadcasts `note_changed`. New
`server/routes/notes.js` (`/api/notes`: CRUD, `?q=` FTS search, `?tag=`/`?project=`
filters, `/tags`, `/config` get/set, the capture inbox drain). New **Notes page**
(`client/src/pages/Notes.tsx`, route `/notes` + sidebar/`nav:notes` locale
en/tr/zh) with a pinned quick-capture box, FTS search + tag chips, a list↔editor
split (plain textarea + `MarkdownContent` preview — no heavy editor dep), a
notes-folder control, and a captures-inbox banner. **G2 (brain):**
`server/lib/brain/router.js` is the tiered router (simple→Ollama, standard→Gemini,
complex→`claude -p`) with a per-tier fallback chain and a `brain_calls` log table;
`server/lib/brain/index.js` `ask()` now dispatches through it (honest stub only
when NO provider is configured), and `server/lib/brain/dump.js` reformats brain
dumps into `{title, body, tags, todos}` (versioned prompts in
`brain/prompts/*.md`) with a deterministic no-provider fallback. `POST
/api/notes/dump` (preview `save:false` → raw↔formatted confirm on desktop; auto-
save from voice) files a `source:dump` note preserving the original; the Phase D
`assistant_captures` "note: …" inbox drains through the same path. `server/lib/
brain/pulse.js` computes the working/neglected/completed tracker (deterministic,
from last session/run/chat/**note** activity + open `- [ ]` todos + project
status) into `project_pulse`, armed via a NEW `registerRecurringTask` on the
SHARED Phase-L scheduler (not a second scheduler; H5 cron reuses it). Pulse renders
on the Projects card grid (dot + summary + "Neglected:" banner), the project
detail (pulse bar + Notes stat + recent-notes feed), and `GET /api/projects/pulse`
(+ `/recompute`). **Verified live** (dev server on the real data dir):
notes CRUD + FTS + tags + config over curl, an external on-disk title edit
reindexed within ~1s (proves the Obsidian-two-way claim), and the brain-dump flow
routed to the user's configured **Gemini** key, returning a real structured note
with extracted todos/tags. Tests: new `server/__tests__/notes.test.js` (11 tests:
CRUD, FTS, tags, config, dump deterministic-fallback preview+save, pulse with
open-todo counting) — `npm run test:server` now 613 pass (was 602); client
typecheck + 248 tests green, zero snapshot churn (Notes/Projects aren't in
`screens.snapshot.test.tsx`). **Not done / deviations:** the notes-dir setting
lives on the Notes page (contextual) rather than the Settings page, to avoid
Settings-snapshot churn — the `/api/notes/config` API is Settings-ready if moved
later. The brain router's tier→provider order is a sensible hardcoded default
(configurable-by-design constants, no Settings UI yet). Router fallback across a
revoked key / killed Ollama (step 6's negative path) was reasoned + unit-covered
via the disabled-provider path, not exercised against a live 429. VN/CN READMEs,
`index.html`, and the wiki were intentionally NOT mirrored (English core only,
matching Phases D/E/F/K/L).

*Two sessions: (1) notes CRUD + files, (2) brain router + reformatting +
activity tracking. Depends on F (project linkage), E1 (provider adapters).*

Session G1 — notes:
1. Notes live as markdown files in a configurable dir (default
   `~/JarvisNotes`, setting in Settings; frontmatter: id, title, tags,
   project, created, updated, source: manual|dump|voice). SQLite `notes`
   table is an **index only** (path, title, tags, project_id, mtime, excerpt,
   FTS5 full-text) — rebuilt by a watcher (chokidar, pattern exists in
   `cc-watcher.js`) so edits made in Obsidian/anywhere show up.
2. Notes page: list + tag/project filters + FTS search; editor pane (plain
   textarea + markdown preview via existing `MarkdownContent` — do NOT pull
   in a heavy editor dep); mobile-friendly quick-capture box pinned on top.

Session G2 — brain:
3. Implement `server/lib/brain/` per §3.2 (router, fallback chain,
   `brain_calls` log table).
4. **Brain-dump flow**: capture box / chat message / Siri "note: …" →
   `POST /api/notes/dump` → brain (standard tier) reformats into structured
   markdown (title, cleaned body, extracted todos, suggested tags + project)
   → saved as a note with `source: dump`, original text preserved in
   frontmatter. Show a diff-style "raw → formatted" confirm on desktop;
   auto-accept from voice.
5. **Working/neglected/completed tracking**: a daily brain task (reuse
   Phase L's `server/lib/scheduler.js` — do not add a second scheduler)
   composes a per-project status from: last session/run activity, note
   todos, project status field. Writes to a `project_pulse` table rendered
   on the Projects page and home ("Neglected: X — no activity in 12 days").
   This same artifact feeds Phase J briefings.
6. Verify: dump → reformat → file on disk → visible in Obsidian; router
   fallback by killing Ollama / revoking Gemini key in a sandbox config.

### Phase H — Skills (tap-to-run automations)

**Status: Implemented (2026-07-04, H1 + H2 in one session; code + docs).** Skill
definitions are markdown+frontmatter files in `~/JarvisSkills` (env
`JARVIS_SKILLS_DIR` or the `app_settings` `skills_dir` key), same file-first
philosophy as Notes but **no SQLite index** — the library is small enough that
`server/lib/skills/store.js` reads the directory straight off disk on every
list/get. A new dependency-free, indentation-based YAML-subset parser
(`server/lib/skills/yaml.js`) handles `params`/`steps` as block lists of flat
mappings plus `|` block scalars, one level more structure than Notes' simpler
frontmatter parser needs. `server/lib/skills/engine.js` runs a skill as a
straight pipeline (no branching/loops, per plan) of typed steps — `shell`
(`execFile("/bin/sh", ["-c", …])`, intentional local code execution), `agent`
(wraps `run-spawner.spawnRun` headless; `wait:false` default so a long Claude
run doesn't hold the skill run open), `brain` (one `brain/router.js` call at a
chosen tier), `notify` (a push), and `phone` (a push deep-linked to
`/skills?phoneRun=<runId>`, where the client renders a plain
`<a href="shortcuts://run-shortcut?name=…">` hand-off link — a real link tap
is what iOS honors for a custom scheme, unlike a Service Worker
`client.navigate()`, mirroring the two-tap honesty of Phase A's permission
flow). Step outputs interpolate into later steps as `{stepN_output}` /
`{<type>_output}`. **Safety model**: `confirm: none|tap|typed` gates who may
trigger a skill; a `voice`/`phone`/`schedule` trigger can **only ever** fire
`confirm: none`, checked once in `engine.runSkill()` so no caller path can
bypass it — including retyping a name for `typed`, which only applies to a
manual run. New additive `skill_runs` table logs execution history with a
live per-step JSON progress array; a `reconcileOrphanRuns()` on boot flips any
row the previous process left `running` to `failed`. New route
`server/routes/skills.js` at `/api/skills` (CRUD, `/config`, `/:id/run`,
`/runs*`) reuses the Run router's loopback-Origin guard (it can spawn shell/
agent processes) — same posture as `/api/run`/`/api/schedules`. New WS types:
`skill_run_started`/`_step`/`_finished`/`_failed`, `skill_changed`. New push
category `skills` added to `PUSH_CATEGORIES`. **H5 (cron)** landed in this same
session rather than a later one: a skill's optional `schedule` (5-field cron)
is checked by a small matcher (`server/lib/skills/cron.js`) ticking every 60s
via `registerRecurringTask` on the **shared Phase-L scheduler** — not a second
scheduler, exactly the extension point Phase L built for this. **Voice**:
`server/lib/assistant.js`'s "run skill `<name>`" — a Phase D stub — now matches
by name and actually runs a `confirm: none` skill, or gives an honest spoken
reason ("needs a tap/typed confirmation — open the Skills page") for anything
else. **Client**: `client/src/pages/Skills.tsx` at `/skills` — a mobile-first
tap-target grid, a run sheet (params + typed-confirmation input), live
per-step progress over WS, a raw-markdown editor (create/edit/delete, no
bespoke form builder), and the phone hand-off banner. Sidebar `nav:skills`;
reachable on mobile via "More" — no dedicated bottom-tab slot, matching the
Chat/Scheduled/Projects/Notes precedent (a deviation from §3.4's original
5-tab proposal, consistent with how those phases already deviated from it).
Three seed skills shipped under `docs/skills/` (daily briefing — scheduled +
`confirm:none`; downloads cleanup — `confirm:typed`; spawn-a-Claude-run —
`confirm:tap`, an `agent` step) plus a `docs/skills/README.md` explaining the
format. Tests: new `server/__tests__/skills.test.js` (18 tests: YAML parser,
store CRUD/validation, engine step execution incl. a shell-step failure
stopping the pipeline and a brain step's honest no-provider error, the
confirm-level safety gate incl. voice/schedule refusal, cancellation actually
killing an in-flight shell child process, the cron matcher, and the voice
run-skill intent both succeeding and being honestly refused) — `npm run
test:server` green (631 total). Client: typecheck clean, `npm run test:client`
248 pass with zero snapshot churn (Skills isn't part of
`screens.snapshot.test.tsx`, matching the Notes/Projects precedent). Docs:
README (new feature-table row + a `Skills (/api/skills)` route-table section +
routing-table row), ARCHITECTURE (a `Skills — tap-to-run automations` prose
subsection + routing-table row), `docs/API.md` (full REST + WS section),
`docs/DATABASE.md` (`skill_runs` table reference), and `.env.example`
(`JARVIS_SKILLS_DIR`) all updated; VN/CN READMEs, `index.html`, and the wiki
intentionally **not** mirrored (English core only, matching Phases D/E/F/G/K/L).
**Not done / deviations**: no on-device verification (no dev server available
in this session — typecheck + full test suites are the verification gate
here, per the same scope precedent as most other phases' initial land); an
`agent` step is exercised only by code review, not a test, since it would spawn
a real `claude` subprocess (run.test.js's job, not this file's) — its wiring
to `run-spawner.spawnRun` is a thin, directly-inspectable call. The `default`
confirm level for a skill that omits the field is `tap` (a reasonable safe
default the plan doesn't pin down explicitly). A `phone` step's push always
uses the `skills` push category regardless of a per-step `category` override
(only `notify` steps honor a custom category) — phone hand-off pushes are
deliberately not muteable independently of the rest of the Skills surface.

*Originally scoped as two sessions: (1) engine + library UI, (2) phone/Siri
surfaces + scheduling. Depends on C (push), D (assistant endpoint), G2 (brain
steps) — all already implemented, so this session did both halves at once.*

1. **Skill definition**: markdown-with-frontmatter files in `~/JarvisSkills`
   (same file-first philosophy as notes): name, icon, description, params
   (typed, promptable), `confirm: none|tap|typed` safety level, and `steps`:
   a small YAML list where each step is one of
   `shell` (command, cwd, timeout), `agent` (provider, prompt template,
   permissionUx), `brain` (task-class, prompt), `notify` (push category,
   message template), `phone` (see step 4). No arbitrary nesting, no
   conditionals in v1 — a skill is a straight pipeline; step outputs
   interpolate into later steps.
2. **Engine**: `server/lib/skills/` — parse, validate, execute with
   per-step logging to `skill_runs` (+ WS `skill_run` broadcasts for live
   progress), cancellation, and the safety model: `confirm: typed` skills
   require retyping the skill name (mirrors destructive-action patterns;
   NEVER bypass on voice/phone triggers — voice can only launch
   `confirm: none` skills, period).
3. **Skills page**: big tap-target grid (mobile-first — this is the "tap a
   skill on my phone" surface), param sheet, live step progress, run
   history. Seed 3 example skills in `docs/` (daily briefing, downloads
   cleanup with typed confirm, "spawn Claude run on project X").
4. **Phone-side actions**: a `phone` step publishes a push whose tap opens
   `shortcuts://run-shortcut?name=<X>` (documented recipe). Be honest in the
   UI: phone steps need one tap on the notification — iOS gives no free
   remote-execution path. Siri trigger: "run skill <name>" via Phase D
   intent parsing.
5. **Scheduling**: optional `schedule` (cron expr) in frontmatter; Phase L's
   shared scheduler runs due skills. This is what makes briefings (Phase J)
   just-a-skill.
6. Verify: execute each seed skill from desktop and from the phone PWA over
   cellular; confirm typed-confirmation gates; `test:server`.

### Phase I — Work panels: dev workflow, calendar/email, system health

**Status: GitHub panel implemented (2026-07-04, code + docs; tests + typecheck only).**
Scope this session was **step 1 (GitHub) only** — a deliberate narrowing of the
"session 1 = GitHub + system health" split (user's call); System Health (step 2)
and Google Calendar/Gmail (step 3, its own session) are **not started**. Server:
`server/lib/github/{config,client,service}.js` + `server/routes/github.js`
(`/api/github` — cached overview, `POST /refresh`, `GET/PUT /config`), behind the
Run router's loopback-Origin guard (it spawns `gh` / writes the PAT). Two auth
backends chosen automatically: the locally-authenticated **`gh` CLI** (recommended
— no stored secret, per-PR CI via `statusCheckRollup`) or a server-side **PAT**
(env `GITHUB_PAT` / gitignored `server/config/github.json`, redacted to `hasPat`;
REST mode lists PRs/issues but **does not** fetch per-PR CI — reported `unknown`).
`fetchOverview()` never throws and its `gh`/`rest` seams are injectable for tests.
A single-row **`github_cache`** table (additive, migration-safe) snapshots the
overview; the poller runs on the **shared Phase-L scheduler** (`registerRecurringTask`,
cadence = `pollMinutes`), broadcasts `github_updated` only on a fingerprint delta,
and fires a new **`github`** push category when a PR newly needs review or a check
goes red. **Latest activity** (added same-day after user feedback): for each
repo, `shapeLatestCommit()` resolves the default branch and its tip commit,
rendering **branch + subject line — never the raw SHA** (`url` links to it) and
detecting a GitHub merge commit (>1 parent or a "Merge pull request #N from
owner/branch" subject) to extract `mergedPr.{number,fromRef,title}` for a
"Merged PR #N: \<title\>" render; a repo whose latest-commit fetch errors is
skipped, not fatal. Client: a self-hiding home command-bridge widget
(`GitHubWidget.tsx`) + a full **GitHub** page (`GitHubPanel.tsx`, `/github`, sidebar
`nav:githubPanel`, reachable on mobile via "More") with a **Latest activity**
section, PRs-awaiting-review / your open PRs (CI badges) / recent issues, and an
inline config editor. New `api.github` group + `GitHub*` types (incl.
`GitHubLatestCommit`) + `github_updated` WS union member + an OpenAPI fragment.
Tests: `server/__tests__/github.test.js` (19 tests — config redact/clamp/parse
incl. accepting a pasted github.com URL and deduping, CI-rollup collapse,
gh-mode PR/issue shaping via injected runner, latest-commit shaping (plain push,
merge detection, malformed-input null, per-repo fetch with newest-first sort,
per-repo error isolation), cache round-trip + fingerprint/broadcast-on-change,
route CRUD); `npm run test:server` now **650 pass** (was 631). Client `tsc -b`
clean, `npm run test:client` **248 pass with zero snapshot churn** (the widget
renders null until configured; the page — like Notes/Projects/Skills — isn't in
`screens.snapshot.test.tsx`). **Deviations:** GitHub config lives on the
**GitHub page**, not Settings (the same contextual-config choice Notes/Skills
made, to avoid Settings-snapshot churn — the plan text says "PAT (Settings)").
VN/CN READMEs + `index.html` + the wiki were intentionally not mirrored (English
core, matching Phases D/E/F/G/H/K/L).
**Not done** (deferred — typecheck-only scope, no dev server): a live poll against
real repos through the authed `gh` (verified only via the injected-runner unit
tests + the deterministic no-repos route path) — including a real-world check
that the "Merge pull request #N from owner/branch" title-extraction heuristic
matches actual `gh`/GitHub-API output shapes on this user's repos; **System
Health** (in-process Mac `os`/`df` stats + the ~50-line remote work-PC agent
POSTing over the tailnet with the Phase-D bearer token, red-state push,
Ollama-up status); and the entire **Google Calendar + Gmail** session (googleapis
OAuth — needs the user to create Google Cloud desktop-app credentials first).

*Two sessions: (1) GitHub + system health, (2) Google calendar/email. Each
panel is a widget on home (compact) + a subpage (full).*

1. **GitHub**: server-side integration using a PAT (Settings) or `gh` CLI:
   open PRs (review-requested / mine / CI status), failing checks, recent
   issues across configured repos. Poll on the existing poller cadence,
   cache in SQLite, broadcast deltas. Widget: "2 PRs need review · 1 CI red".
2. **System health**: Mac stats sampled in-process (loadavg, mem, disk via
   `os` + `df`); work PC runs a ~50-line Node agent (in `scripts/`,
   documented) POSTing the same shape over the tailnet every 60s with the
   Phase D bearer token. Home widget: two small gauges; red state pushes a
   notification (category from C3). Ollama-up status rides on this.
3. **Google Calendar + Gmail**: server-side `googleapis` OAuth (free, its
   own desktop-app credentials — the claude.ai connectors are unrelated and
   unusable here), read-only scopes first. Panels: today/next-48h agenda;
   unread-important triage (brain `simple` tier labels: needs-reply / FYI /
   ignore). Agenda feeds Phase J briefings. Calendar *write* (create events
   via chat/voice) is a stretch goal behind a setting, off by default.
4. Verify each integration against real accounts; document every setup step
   (PAT scopes, OAuth consent screen) in SETUP.md.

### Phase J — Proactive Jarvis: briefings + neglect nudges

*One session. Pure composition — depends on C, G2, H5, I.*

1. **Morning briefing skill** (seeded, scheduled): brain composes from
   project_pulse + agenda + GitHub + overnight run results + system health →
   push notification + a briefing note; `speech` variant so "Hey Siri,
   Jarvis, morning briefing" reads it in the car.
2. **End-of-day summary**: what ran, what completed, what's waiting on you,
   what was neglected. Same pipeline, evening cron.
3. **Nudge rules** (deterministic, not brain-hallucinated): agent waiting >
   N min → push; run failed → push; project silent > N days → weekly digest
   mention (not an instant push). All behind the C3 category toggles with
   sane defaults; every push deep-links to the relevant page.
4. Verify: force each trigger, receive on phone over cellular, links land.

---

## 5. Sequencing & dependency graph

```
A (permissions UI)          — independent, do first
B (home redesign)           — independent of A; do second (visible win)
C (tailscale+PWA+push)      — independent; unlocks all mobile value
K (multi-account tracking) — independent; slotted after C
L (scheduled prompts) ──── independent (run lifecycle only); after C/K
D (voice) ─────────────── needs C  (brain stub OK before G)
E1 (providers+chat) ────── independent
E2 (gemini agentic) ────── needs E1
F (projects) ───────────── independent
G1 (notes) ─────────────── needs F
G2 (brain) ─────────────── needs E1, G1
H (skills) ─────────────── needs C, D, G2
I (work panels) ────────── needs C (push), brain optional until triage
J (proactive) ──────────── needs C, G2, H, I
```

Recommended order: **A → B → C → K → L → E1 → F → G1 → G2 → D → H → I → J.**
(D slots earlier with a stubbed brain if voice is wanted sooner. K and L are
lettered out of sequence to avoid renumbering D–J references; they execute
right after C.)

## 6. Repo-wide execution rules for every phase

- Additive, migration-safe schema only; API response shapes backward
  compatible; WS message types stable (new types fine, changed types not).
- All secrets server-side (`server/config/*.json` gitignored + Settings UI).
- Every phase ends with: `npm run test:server`, `npm run test:client`
  (snapshot diffs reviewed, never blind `-u`), `/verify` on the live app for
  UI phases, and docs updated in the same change-set per the
  `update-project-docs` skill (README/ARCHITECTURE/SETUP/wiki as touched).
- Any chart/gauge work: read the `dataviz` skill first; reuse `--chart-*`
  and holo-panel tokens.
- New always-on processes (scheduler, pollers, watchers) must be fail-safe:
  crash-log-and-continue, never take the server down.

## 7. Backlog of extra ideas (not scheduled — pick later)

- **Move the server to the 24/7 work PC** so Jarvis survives Mac sleep
  (the Mac becomes just another node; Claude runs would need the Mac awake
  anyway, but monitoring/notes/brain/skills stay up).
- **Wake-word desktop voice** (local whisper via Ollama-adjacent tooling) —
  talk to Jarvis at the desk like in the car.
- **Usage/cost intelligence**: per-provider spend + Claude session-window
  forecasting ("at this burn rate you hit the cap at 3pm").
- **Clipboard/file inbox**: share-sheet target on iOS (PWA share_target in
  the manifest) → send links/screenshots from the phone into notes inbox.
- **Watch complications** via the PWA-adjacent iOS Shortcuts widgets —
  glanceable agent count without opening anything.
- **Home dashboard TV mode**: read-only `/wall` route, big-type instruments
  for a spare monitor.
- **Media/downloads butler skill pack**: subscriptions renewals tracker,
  invoice folder organizer — cheap wins on the skills engine.
- **Ultron takeover easter egg is already in the codebase** (`UltronTakeover
  .tsx`) — a "Jarvis offline / Ultron mode" theme toggle is free personality.

---

*End of plan. Each phase names its verification gate; a phase is not done
until its gate passes on-device where applicable.*
