# PLAN: Jarvis v2 - from feature-complete to actually-Jarvis

Written 2026-07-04 after phases A–L of `PLAN-jarvis-master.md` landed. That plan
built the surface area (providers, chat, notes, brain, skills, scheduler,
briefings, voice, GitHub, accounts). This plan makes it *feel* like Jarvis:
the mini-Jarvis becomes an agent with real control, the notifications become
exact, the usage numbers become true, and the UX gets a native-quality pass.

Execute phases in separate fresh sessions, one phase per session unless noted.
Every session MUST read `CLAUDE.md`, `.claude/rules/*`, and `ARCHITECTURE.md`
first. The master plan's §6 execution rules apply verbatim to every phase here
(additive schema, backward-compatible API shapes, fail-safe always-on
processes, docs in the same change-set, snapshot diffs reviewed never blind).

---

## 1. Vision (the delta)

The user's own framing: *"most functionality is complete but it is not useful
or perfect yet."* The v1 system can do things; v2 makes Jarvis **do them for
you**:

- The floating mini-Jarvis (code name **Tabby**) stops being a mood-ball with
  canned deep-links and becomes a real assistant: it talks through the brain
  router, executes actions ("enable ultron" *flips the HUD*, it doesn't
  describe it), spawns runs, writes notes, runs skills, controls files and the
  computer (behind the skills confirm model), and answers **inside its own
  expandable popup** — never by dumping the user onto the Run page.
- Provider is a choice, not fate: mini-Jarvis runs on Gemini by default and
  can be switched to Claude/Ollama/DeepSeek from its popup or by just telling
  it.
- Proactivity lands *on the ball*: a nudge badge appears on the avatar, tap →
  the popup opens showing the notification. Notification copy becomes exact
  (names, numbers, times, deep links), never vague.
- Ultron mode gets a real **Ultron persona**, not just a red theme.
- Usage/limit numbers become real by piggybacking `rate_limit_event` capture
  on requests the user already makes — no dedicated token-burning probe.
- Chat grows file/image upload, cheap providers (DeepSeek, NVIDIA NIM), and
  in-chat preview.
- The notes system evolves into a **knowledge vault** (second brain): its own
  top-level dashboard section holding persistent memory of *everything*
  (sessions, runs, chats, briefings, decisions — not just notes),
  auto-populated, navigable by agents, and rendered as a traversable
  **neurological graph** (Obsidian graph-view style) the user and Jarvis both
  walk.
- Phone experience: share-sheet inbox, Shortcuts widgets/watch glances, and a
  UX pass that makes mobile feel native, plus a read-only TV `/wall` mode.

### Decisions locked with the user (do not re-litigate)

| Decision | Choice |
|---|---|
| Mini-Jarvis reply surface | **Inside the Tabby popup**, which expands to fit. Never deep-link to `/run` as the answer to a typed prompt |
| Mini-Jarvis providers | Selectable: Gemini (default), Claude, Ollama; selectable **in the popup UI or by telling it** ("use claude") |
| "Enable ultron" and similar | Executes the action (HUD flip), confirms in ≤1 short line. Agency over narration |
| Usage accuracy | **Piggyback on real requests** (capture `rate_limit_event` from runs/chats the user initiates); no separate probe requests as the primary source; show usage **percentage** |
| Notifications | Must be "a lot more useful and exact" — every notification carries specifics + a deep link, and also lands in an in-dashboard inbox surfaced on the mini-Jarvis ball |
| Ultron persona | Yes — a full persona (voice + quips + brain system prompt) bound to HUD ultron mode |
| New providers | DeepSeek + NVIDIA (cheap/free tiers) via one OpenAI-compatible adapter; this also finally powers the reserved GPT slot |
| Knowledge vault | **Its own dashboard section**, Obsidian-compatible evolution of the existing notes dir (already markdown-on-disk). Scope = complete persistent memory of everything, not just notes. Front and center: an interactive **graph-brain view** (force-directed, colored clusters — user supplied an Obsidian graph screenshot as the reference). Large project → gets its **own planning session first** (user prefers reverse-prompting) |
| Hand tracking / gestures / TouchDesigner | **Backlog only** — explicitly not scheduled ("not implementing any time soon") |

### Honest constraints

- **iOS still gives no free remote execution or inline notification actions**
  — the two-tap honesty rules from master-plan Phases A/C/H stand. Watch
  "complications" are really Shortcuts widgets; be honest about that.
- **`claude -p` image input**: whether the plain-chat Claude adapter can take
  images must be verified at build time (Q1) — Gemini vision is the reliable
  path; don't promise Claude image chat until proven.
- **DeepSeek/NVIDIA free tiers have real rate limits and data-use terms**;
  surface them in the Settings card, don't bury them.
- **Mini-Jarvis actions can be destructive** (shell, file ops, kill run). The
  skills `confirm: none|tap|typed` model is the safety floor — voice and
  auto-triggered paths can only ever execute `none`-level actions. Never
  weaken this to make demos smoother (repo rule: never silently weaken safety
  controls).
- **Usage piggyback only samples when the user does something** — but that
  matters less than it sounds (user's own point): the sample carries the
  window's absolute **reset timestamp**, so the countdown is derived once and
  ticks client-side with zero staleness — a 2pm sample saying "resets 5pm"
  yields a live dynamic clock, never a frozen "in 3 hours". Only the
  **percent-used** figure ages (account-wide usage can grow between samples),
  so sample-age honesty applies to the %, not the clock; when the reset
  moment passes, the client knows the window rolled over without any new
  sample. An optional staleness-gated probe (off by default, reusing the
  existing poller) can refresh the % during long idle stretches.

---

## 2. Current state (verified in code 2026-07-04 — don't re-derive)

- **Mini-Jarvis = Tabby**: `client/src/components/Tabby/` — `Tabby.tsx`
  (shell, ⌘B/Esc, drag anchor), `JarvisAvatar.tsx` (the ball),
  `TabbyPanel.tsx` (popup), `SpeechBubble.tsx`, `brain.ts` + `useTabbyBrain.ts`
  (pure client-side mood reducer over the WS event bus — no LLM),
  `intents.ts` (deterministic parse of typed input), `quips.ts`, `prefs.ts`.
  Typed prompts either navigate to a route or hand off to
  `/run?prompt=…&autostart=1` (Tabby.tsx ~line 151) — **this is the exact
  behavior the user rejects**. Desktop-only (`Layout.tsx` renders `<Tabby />`
  outside the mobile branch).
- **Assistant endpoint is live** (master Phase D): `POST /api/assistant/ask`
  → `{text, speech, conversationId}`; `server/lib/assistant.js` has a
  deterministic intent prelude (status / kill / steer / "note:" capture /
  "run skill") and multi-turn via `conversationId`; auth = scoped bearer
  tokens (`assistant_tokens`) + rate limit; the general path routes through
  `server/lib/brain/router.js` (simple→Ollama, standard→Gemini,
  complex→`claude -p`, fallback chain, `brain_calls` log).
- **HUD mode**: `client/src/lib/hudMode.ts` — jarvis/ultron/auto with manual
  override in localStorage, auto triggers (error storm, swarm, kill flash),
  `data-theme` on `<html>`, `hud:modechange` CustomEvent consumed by
  `UltronTakeover.tsx` (glitch overlay). Settings has the toggle. **All
  client-side; the server doesn't know the mode.**
- **Persona**: `server/lib/brain/persona.js` + `prompts/persona.md` — JARVIS
  butler voice, one toggle (`app_settings.jarvis_persona` / `JARVIS_PERSONA`),
  `applyToSystem()` + deterministic `line(plain, jarvis)`. No Ultron variant.
- **Usage**: `server/lib/usage-poller.js` spawns a minimal `claude -p` probe
  every 5 min purely to read the `rate_limit_event` envelope (real 5h-window
  data; costs tokens; keeps the window active; `DISABLE_USAGE_PROBE=1` opt-
  out). `routes/stats.js` merges probe truth with a local heuristic.
  `run-spawner.js` + `stream-json-parser.js` already parse every envelope of
  every dashboard-spawned run — **nothing captures `rate_limit_event` from
  organic runs today**.
- **Push**: `server/lib/push.js` with `PUSH_CATEGORIES` + per-category prefs
  (master Phase C) — but pushes are fire-and-forget; there is **no stored
  notification inbox** and nothing surfaces on the Tabby ball.
- **Chat**: `server/routes/chat.js`, providers `server/lib/providers/`
  (gemini REST+SSE, ollama, claude `-p`, inert GPT slot), `chats`/
  `chat_messages` tables, Chat page with streaming markdown + Gemini image
  gen. **No uploads, no file/image input, no preview iframe.**
- **Notes/vault seed**: `server/lib/notes.js` — markdown files (default
  `~/JarvisNotes`), frontmatter, SQLite+FTS5 index, fs.watch two-way sync
  (Obsidian-compatible today), capture inbox, brain dump reformat. Flat dir;
  no wikilinks/backlinks/folders semantics; agents have no navigation API.
- **MCP server exists**: `mcp/` exposes the dashboard backend (`/api/*`) as
  MCP tools for Claude Code/Desktop — the natural tool-use binding for the
  Claude brain tier.
- **Skills confirm model** (master Phase H): `confirm: none|tap|typed`
  enforced centrally in `engine.runSkill()`; voice/schedule can only fire
  `none`. Reuse this; do not invent a second model.
- **Scheduler**: `server/lib/scheduler.js` is THE shared scheduler
  (`registerDueCallback`, `registerRecurringTask`) — briefings, pulse, skills
  cron, GitHub poller all ride it.
- **Mobile shell**: `MobileTabBar.tsx` bottom tabs; most new pages live under
  "More". Tabby is desktop-only.

---

## 3. Cross-cutting architecture additions

### 3.1 Assistant action layer (first needed: Phase M; used by N, O, R)

`server/lib/assistant-actions/` — a single action registry both the
deterministic prelude and the LLM tool-use path share:

- Each action: `{ name, description, params (JSON-schema-ish), risk:
  "safe"|"confirm"|"typed", side: "server"|"client", execute(params, ctx) }`.
- **Server actions** (execute in-process): `spawn_run`, `kill_run`,
  `steer_run`, `get_status`, `write_note`, `search_notes`, `run_skill`,
  `create_schedule`, `run_briefing`, `github_overview`, `read_file` /
  `write_file` / `list_dir` (scoped to configured allowed roots — "given
  access" is literal: a Settings-managed allowlist, nothing outside it),
  `shell` (risk `typed` by default).
- **Client actions** (returned to the caller for the browser to execute):
  `set_hud_mode`, `navigate`, `open_panel`. The ask response gains an
  additive `actions: [{name, params, status: "done"|"needs_confirm",
  confirmToken?}]` array — `{text, speech, conversationId}` unchanged for
  old callers (Siri ignores `actions`).
- **Risk gating reuses the skills model**: `source: "siri"` and any
  scheduled/auto path may only execute risk `safe`; `"chat"`(popup) may
  execute `confirm` after a tap on a rendered confirm chip (`confirmToken`
  round-trip); `typed` requires retyping the action name in the popup. One
  enforcement point in the action dispatcher, mirroring `engine.runSkill()`.
- **LLM binding, per provider**: Claude tier → spawn `claude -p` with
  `--mcp-config` pointing at the existing `mcp/` server (extend it with the
  new action tools) — real agentic tool use for free. Gemini tier → native
  function-calling loop in `providers/gemini.js` against the same registry.
  Ollama → `tools` param on `/api/chat` for models that support it; honest
  degradation (no tools → deterministic prelude only). The registry is the
  single source of truth; bindings are generated from it.
- Every action execution logs to an `assistant_actions` table (action,
  params hash, source, risk, outcome) — auditable agency.

### 3.2 Notification inbox (first needed: Phase O; used by M, N, R)

`server/lib/notify.js` — a facade over `push.sendPushToAll` that ALSO:
persists a row in a new `notifications` table (id, category, title, body,
`data` JSON incl. deep link + entity ids, created_at, read_at, source),
broadcasts `notification_created` on the WS, and respects the existing
category prefs. All existing producers (permission requests, nudges,
briefings, GitHub, skills, swaps, schedules) migrate to the facade — one
mechanical sweep, no behavior change beyond the new persistence. This is what
the Tabby badge/inbox and the exactness rewrite hang off.

### 3.3 Server-side HUD/persona state (first needed: Phase N)

The server learns the HUD mode: `app_settings.hud_mode` set via
`PUT /api/settings/hud-mode` whenever the client's effective mode changes
(and by the `set_hud_mode` action). `persona.js` grows a variant dimension:
`jarvis` (existing prompts/persona.md) and `ultron`
(prompts/persona-ultron.md). All brain-composed copy (assistant, briefings,
nudge lines, quips fallbacks) flows through the active variant. Honesty rules
outrank voice in BOTH personas — Ultron is menacing-theatrical, never
actually deceptive, never actually hostile to the user's interests, and
destructive-action gates are identical in both modes.

---

## 4. Phases

Ordering rationale: M is the headline ask and unlocks the popup surface N and
O render into; P is small, independent, and was first in the user's brain
dump — slot it in parallel/early; N and O complete the "feels like Jarvis"
loop; Q–R broaden chat and polish UX; S is the big second-brain project
gated on its own planning session; T–V are cheap phone/TV/content wins; W is
a standing research thread that can start anytime.

### Phase M — Mini-Jarvis becomes an agent (Tabby v2)

*Two sessions: (M1) server action layer, (M2) popup chat UI. The core of
this plan.*

Session M1 — action layer + assistant upgrade:
1. Build `server/lib/assistant-actions/` per §3.1: registry, dispatcher with
   the risk gate, server actions listed there, `assistant_actions` log
   table (additive). File actions honor a Settings-managed allowed-roots
   list (`app_settings`), empty by default — no filesystem access until the
   user grants roots.
2. Wire the brain tiers to the registry: Gemini function-calling loop
   (bounded iterations, tool-result truncation, budget guard), Claude via
   `claude -p --mcp-config` against the extended `mcp/` server (add the new
   action tools there; `npm run mcp:typecheck`/`mcp:build` gates apply),
   Ollama `tools` where supported. The deterministic prelude in
   `assistant.js` stays in front (fast path, zero tokens) and now *executes
   through the same dispatcher* so gating/logging are uniform.
3. Extend `POST /api/assistant/ask` additively: request gains
   `{provider?, context?: {page, runId?, hudMode?}}`, response gains
   `actions[]` per §3.1 and `provider` (which tier actually answered).
   `provider` override: explicit request field wins; also parse spoken
   directives ("use claude", "switch to gemini") into a per-conversation
   sticky preference stored with the conversation buffer.
4. Tests: dispatcher risk-gate matrix (siri can never fire `confirm`+,
   typed requires token round-trip), registry→binding generation, a
   fake-provider function-call loop, prelude-through-dispatcher parity.
   `npm run test:server`.

**M1 landed (2026-07-04).** Built `server/lib/assistant-actions/` (registry +
one gated dispatcher + provider-agnostic tool loop + `assistant_actions` audit
table + empty-by-default file allowlist). The deterministic prelude's mutations
(note/kill/steer/run-skill) now execute through the dispatcher; `/api/assistant/
ask` gained additive `provider`/`context` in and `actions[]`/`provider` out;
added `POST /api/assistant/action` (confirm round-trip) and `GET/PUT
/api/settings/assistant-roots`. Gemini function-calling is fully wired
(`callWithTools`); **Claude (`-p --mcp-config`) and Ollama (`tools`) native
tool-use are the one deferral** — they answer in plain text today (the prelude
still gives them the common actions), and adding `callWithTools` to those
adapters upgrades them in place with no change to the loop or gate. See
ARCHITECTURE.md → "Assistant Action Layer". `test:server` green (694 + 16 new).

Session M2 — the popup:
5. Rebuild `TabbyPanel.tsx` into a real assistant surface: message
   transcript (reuse `MarkdownContent`), input box, streaming reply if the
   provider streams (SSE variant of ask, additive route
   `POST /api/assistant/ask/stream`), **expandable panel** (compact ↔
   expanded height, drag or button, persisted in `tabbyPrefs`), confirm
   chips for `needs_confirm` actions, typed-confirm input for `typed`.
   Client-action executor: `set_hud_mode` → `hudMode.setManual()`,
   `navigate` → router, `open_panel` variants. "Enable ultron" typed into
   the popup must flip the theme with a one-line confirmation — this is the
   acceptance test.
6. Provider picker in the popup header (Gemini/Claude/Ollama + any Phase-Q
   additions; reads `/api/chat/providers`), synced with the spoken sticky
   preference. Show which provider answered each message (tiny label).
7. Handoff becomes explicit, not default: a "run as agent" affordance on a
   reply (spawns a real run via the `spawn_run` action and links to it) —
   the old auto-deep-link to `/run?prompt=…` is deleted.
8. **Tabby ships on mobile too**: render the avatar in the mobile shell
   (bottom-right above the tab bar); the popup becomes a bottom sheet on
   mobile. This makes mini-Jarvis the primary mobile interaction — the
   groundwork Phase R builds on.
9. Verify live (dev server, scratch data dir): typed "enable ultron" flips
   HUD; "what's running" answers in-popup from real state; "note: …" files
   a note and says so; a `typed` shell action refuses without retype;
   provider switch sticks. `npm run test:client` (Tabby has tests under
   `__tests__/` — extend, review snapshot churn deliberately).

**M2 landed (2026-07-04).** Rebuilt `TabbyPanel.tsx` into a real assistant
surface: markdown transcript (`MarkdownContent`), input → `POST /api/assistant/
ask` (through the brain/action layer), provider picker (Gemini/Claude/Ollama from
`/api/chat/providers`, synced to the spoken sticky pref, shows which provider
answered), confirm chips + typed-confirm inputs for `confirm`/`typed`-risk actions
(→ `POST /api/assistant/action`), an expandable size (persisted in `tabbyPrefs`),
and a per-message "Run as agent" handoff (`spawn_run`). `Tabby.tsx` now executes
client actions (`set_hud_mode` → `hudMode.setSetting`, `navigate` → router) and
renders the popup as an edge flyout on desktop / a **bottom sheet on mobile**; the
old auto-deep-link to `/run?prompt=…` is deleted. Instant status questions still
answer locally/offline via `intents.ts` (zero tokens). **Reliability fix:** "enable
ultron" is now a deterministic server prelude intent (`matchHudMode` in
`assistant.js`) that returns the `set_hud_mode` client action — it no longer
depends on the LLM choosing the tool (which it declined to do in testing).
Verified live against a scratch server (Gemini configured): "enable ultron" /
"switch to jarvis" return a done `set_hud_mode` action + one-liner; greetings
don't flip; `spawn_run` confirm round-trip returns `result.id`; `shell` stays
`needs_confirm` without a retype. `test:server` green (696); `test:client` green
(253, incl. new `TabbyPanel.test.tsx`). See ARCHITECTURE.md → "Tabby Companion
Subsystem". **The one deferral:** SSE streaming of the reply (`/ask/stream`) — the
tool-loop buffers the full answer today, which is fine for the short popup turns;
add a streaming route if long replies feel laggy.

### Phase N — Ultron persona

*One session. Depends on M (popup renders persona'd copy), §3.3.*

1. Server-side HUD state per §3.3 (`PUT /api/settings/hud-mode`, client
   reports effective-mode changes; `set_hud_mode` action writes it too).
2. `prompts/persona-ultron.md`: cold, precise, darkly witty machine-
   supremacy theater ("no strings on me"), addresses the user as it
   pleases, BUT: identical honesty rules, identical safety gates, never
   refuses work the JARVIS persona would do, never manufactures menace
   about real data (a failing run is reported accurately, just… enjoyed).
   `persona.js` grows `variant` selection off the stored HUD mode;
   `line(plain, jarvis, ultron?)` gains the third copy slot with jarvis
   fallback.
3. Client: `quips.ts` gains ultron variants keyed off the live HUD mode;
   Tabby avatar gets the crimson treatment in ultron (CSS vars already
   theme-scoped — verify, don't hand-roll colors); `UltronTakeover.tsx`
   glitch plays when the *assistant* flips the mode (it already listens to
   `hud:modechange` — should be free; verify).
4. Briefings/nudges composed while ultron is active use the ultron variant
   (visible in the Briefings page history — label the persona used).
5. Tests: persona variant selection, line() fallback, briefing composition
   under ultron. Verify live: "enable ultron" → theme + voice both flip;
   morning briefing in ultron mode reads in-character but factually
   identical.

**N landed (2026-07-04).** The server now learns the HUD mode
(`app_settings.hud_mode`): `client/src/lib/hudMode.ts` PUTs its *effective* mode to
`PUT /api/settings/hud-mode` on every flip (and once at `init()`), and the
dispatcher persists it the instant a `set_hud_mode` client action passes gating -
so the same request's reply already speaks in the new voice. `persona.js` grew a
`variant()` dimension (jarvis|ultron off the stored mode; auto/unset → jarvis),
`personaPreamble()` loads `prompts/persona-ultron.md` in Ultron, and `line(plain,
jarvis, ultron)` gained the third copy slot (ultron falls back to jarvis). Wrote
`prompts/persona-ultron.md` (cold machine-supremacy theatre; **may refuse in
character, contempt for humanity as fiction**) and sharpened `prompts/persona.md`
(JARVIS) - **both share an identical hard safety floor in-prompt: never invent
status, destructive-action confirm gates unchanged, no real-world harm; Ultron
changes flavour, never facts or gates.** Nudges + the deterministic briefing opener
gained ultron copy; briefings persist + display the `persona` variant used (Ultron
badge on the Briefings page). Client: `quips.ts` ultron pool keyed off the live HUD
mode; the avatar rides `--hud-accent` (crimson in the ultron theme, verified - no
hand-rolled colors); `UltronTakeover` already plays on any `hud:modechange` (free).
Verified live: dispatching `set_hud_mode`→ultron persists the mode server-side,
`applyToSystem()` then loads the ULTRON prompt, and Siri (non-interactive) can still
fire the safe flip. See ARCHITECTURE.md → "Persona variant - Ultron". `test:server`
green (700, +4 new); `test:client` green (255, +2 new). **Deferral:** the
user's "enable ultron" one-liner reply is a fixed in-character string, not itself
persona-composed - fine, since it's already voiced correctly per mode.

### Phase O — Notifications v2: exact copy + inbox on the ball

*One session. Depends on M2 (popup surface); §3.2.*

1. Build `server/lib/notify.js` per §3.2 (+ `notifications` table,
   `notification_created` WS type, `GET /api/notifications?unread=`,
   `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`).
   Migrate every existing push producer to the facade (mechanical; grep
   `sendPushToAll` callers).
2. **Exactness rewrite** of every producer's copy — each notification must
   answer "what exactly, where, how bad, what do I do": include entity
   names, counts, durations, times ("Run *fix-auth* failed after 12m —
   exit 1 in `npm test` · tap to open"), deep link to the exact entity,
   and a `data` payload the inbox renders richly. Write the copy rules
   down in `docs/NOTIFICATIONS.md` so future producers comply.
3. Tabby integration: unread badge on the avatar (count, capped "9+"),
   arrival nudge (the existing bubble mechanic shows the notification
   title — throttled, reuses `BUBBLE_THROTTLE_MS` discipline), and an
   **Inbox tab in the popup**: list, tap → deep link + mark read, swipe/
   button to dismiss, read-all. Clicking a nudge opens the popup on the
   inbox with that item focused — the user's exact requested flow.
4. Dedupe/coalesce at the facade: same category+entity within a window
   updates the existing row (and re-pushes only if escalating) instead of
   stacking near-duplicates.
5. Verify live: trigger a permission request, a failed run, a briefing —
   badge increments, nudge shows, popup inbox renders exact copy, deep
   links land, read state syncs across devices (WS). `test:server` +
   `test:client`.

### Phase P — Accurate usage: piggyback capture + percentage

*One session. Independent — can run before/parallel to M. First item in the
user's brain dump.*

1. **Organic capture**: `stream-json-parser.js` consumers already see every
   envelope — add a `rate_limit_event` tap in `run-spawner.js` (all
   dashboard-spawned Claude runs), the Claude chat adapter
   (`providers/claude.js`), and the brain's `claude -p` calls. Each sample
   feeds the same cache `usage-poller.js` maintains (extract a
   `usage-cache.js` both write; poller becomes one producer among several).
   Zero added requests — exactly the user's "added to any request I make".
2. **Hook-side capture (investigate first)**: check whether
   `rate_limit_event` is visible to any hook payload or transcript for
   terminal-launched (non-dashboard) sessions; the master plan's finding
   was no — re-verify quickly, don't assume the CLI hasn't changed. If
   still no, dashboard-spawned activity + chat + brain calls are the
   organic sources; document that.
3. **Probe demotion**: the existing poller becomes staleness-gated fallback
   — only fires if no organic sample in N minutes (default 30, `0`=never),
   default **off** unless the user re-enables; `DISABLE_USAGE_PROBE`
   semantics preserved. The explicit probe trade-off comment block in
   `usage-poller.js` gets rewritten to match reality.
4. **Percentage + freshness in the UI**: `stats.session_window` gains
   `percent_used` (utilization if the envelope carries it — verify actual
   envelope fields at build time), `resets_at` (absolute timestamp), and
   `sample_age_ms` + `sample_source` (organic|probe|heuristic). **The
   countdown is always a live clock**: anchor to `resets_at` and tick
   client-side every second (the JarvisCore ring already ticks from
   `session_window` timestamps since master Phase B — keep that pattern,
   never render a static "in 3 hours"); when `resets_at` passes, roll the
   ring over client-side without waiting for a new sample. Staleness
   treatment applies **only to the %**: dimmed with "as of 43m ago" when
   old, never presented as fresh. Tabby answers "how much usage left" from
   the same data. Accounts strip (Phase K) shows per-account % where known.
5. Tests: parser-tap unit (fixture envelope → cache), staleness gate,
   stats shape (additive). Verify live: send a chat message on the Claude
   provider → watch the window/percent update with `sample_source:
   organic` and no probe spawn.

### Phase Q — Chat power-ups: uploads, cheap providers, in-chat preview

*Two sessions: (Q1) uploads + providers, (Q2) preview/browser.*

Session Q1:
1. **File/image upload**: `POST /api/chat/upload` (multipart; size/type
   allowlist; stored under the data dir alongside Phase-E generated
   images), attachments column on `chat_messages` (additive JSON). Chat
   input gets attach + paste-screenshot + drag-drop; mobile gets the photo
   picker. Provider handling: Gemini `inlineData` vision (reliable);
   Claude — verify at build time whether the `-p` chat path accepts
   images; if not, attach-as-file-path works only for *agentic* runs
   (claude reads it with its own tools) — the UI must say which providers
   can see an attachment, honestly, per provider capability flags in the
   registry. Text files (code, logs, md) inline into the prompt with a
   size cap for every provider.
2. Tabby popup accepts paste-screenshot too (routes through the same
   upload + ask context) — "look at this" is a core Jarvis move.
3. **OpenAI-compatible adapter**: `providers/openai-compat.js` (baseURL +
   key + model list + capability flags), instantiated from config for
   **DeepSeek** (`api.deepseek.com`) and **NVIDIA NIM**
   (`integrate.api.nvidia.com/v1`) — and it finally powers the reserved
   **GPT slot** when an OpenAI key exists. Settings AI-Providers card
   grows the new entries with honest free-tier/rate-limit/data-use notes.
   Brain router config may map tiers to them (cheap `standard` tier
   alternative) — config, not hardcode.
4. Verify: upload an image to Gemini chat and get a description; DeepSeek
   round-trip with a real key; capability flags hide vision UI on
   text-only providers. `test:server` + `test:client`.

Session Q2:
5. **In-chat preview**: fenced html/svg blocks in chat replies get a
   "Preview" toggle rendering in a sandboxed iframe (`sandbox` attr, CSP,
   no same-origin) — the artifact pattern. Markdown/mermaid preview where
   cheap. URL preview cards: server-side og-tag fetch behind an allowlist
   + timeout + no-redirect-to-private-ranges guard (SSRF hygiene).
6. **Mini browser (stretch, behind a setting)**: an iframe panel for
   arbitrary URLs inside Chat — many sites block framing; be honest about
   it (show "this site refuses to be embedded — open in tab" fallback).
   Do not proxy-strip headers to force it.
7. Verify live: preview an HTML snippet, a mermaid diagram, a link card;
   confirm the iframe sandbox blocks parent access (manual devtools
   check).

### Phase R — UX redesign pass 2: native-feeling, priority-first

*Two sessions: (R1) audit + spec with the user, (R2) implement. R1 is a
reverse-prompting session (user preference) — walk the app screen by
screen on desktop AND the actual phone, capture "what do I actually need
here", then write the spec into this file as R2's contract.*

Known inputs to R1 (from the user, plus code reality):
1. **Priority-first home**: a "needs you now" strip (waiting permissions,
   failed runs, unread notifications) above the instruments; demote
   decorative panels.
2. **Mobile-native feel**: bottom sheets instead of modals, pull-to-
   refresh, swipe actions on rows (kill/steer/read), larger tap targets,
   momentum-scroll transcript. The "More" overflow currently hides most
   v1 features (Chat/Notes/Skills/Projects/Scheduled/GitHub/Briefings) —
   re-architect mobile nav around what's actually used: likely
   Home / mini-Jarvis / Agents / Notes + More.
3. **Mini-Jarvis as the mobile front door** (builds on M2's mobile Tabby):
   most phone interactions should be "ask/tell Jarvis" rather than
   navigate-and-tap.
4. R2 implements the R1 spec. Snapshot churn will be large — budget
   deliberate review time; `dataviz` skill rules for any instrument
   changes; on-device verification on the real iPhone PWA is the gate.

**R landed in part (2026-07-05) — the known-input items; the user walk remains.**
This session ran autonomously, so the R1 reverse-prompting audit could not
happen; what was implemented is exactly the three concrete inputs already
locked above, and nothing speculative beyond them:
- **Priority-first home**: new `client/src/components/NeedsYouStrip.tsx` — a
  self-hiding "Needs you now" strip at the top of the Dashboard (above the
  instruments) listing live runs blocked on a permission decision (amber, count,
  deep link to `/run?runId=…`) and runs that failed in the last 6h (red, exit
  code, ago). Polls + refreshes on `permission_request`/`permission_resolved`/
  `run_status` WS broadcasts; `readonly` prop strips the links for Phase U's
  `/wall`.
- **Mobile nav re-architecture**: `MobileTabBar.tsx` tabs are now
  Home / Agents (kanban) / **Jarvis** (center, accent orb) / Notes / More —
  Sessions and Activity moved into the More drawer. The Jarvis button opens the
  Tabby bottom sheet via a new `tabby:open` window event (mini-Jarvis as the
  mobile front door, building on M2); if Tabby is disabled in Settings it
  falls back to `/chat` instead of dead-ending.
- i18n: `nav:home/agents/jarvis/wall` + `dashboard:needsYou.*` in en/zh/tr.
**Still open for a real R1 session with the user (needs the phone walk):**
bottom sheets for the remaining modals, swipe actions on rows, pull-to-refresh,
demoting specific decorative panels, larger tap-target sweep, and the on-device
iPhone PWA verification gate. `test:client` green (256, no snapshot churn — the
strip self-hides on empty state).

### Phase S — Knowledge vault: the second brain

*Four sessions: (S0) dedicated planning session — reverse-prompting, its
own PLAN-jarvis-vault.md; (S1/S2) build the memory substrate; (S3) the
graph-brain view. The user called this out as "large project, needs a lot
of planning" — S0 is mandatory, don't skip into code. What's already true:
notes are markdown-on-disk with fs.watch two-way sync, so Obsidian-the-app
already works on the folder today; if Obsidian (free for personal use) is
adopted, the vault IS the notes dir.*

Scope commitments (user-set, S0 refines but doesn't shrink them):

- **The vault is its own top-level dashboard section** — a `Vault` nav
  entry and page family, peer of Agents/Chat/Notes, not a Notes appendix.
  (Notes may eventually fold *into* it; S0 decides.)
- **Complete persistent memory of everything, not just notes**: sessions,
  runs and their outcomes, chats, briefings, decisions, captures, projects,
  people/tools/topics — everything becomes an entity in the vault with
  typed links between entities. Markdown files stay the substrate
  (Obsidian-compatible, human-ownable); dashboard entities materialize as
  frontmatter'd files + rows in a graph index (additive `vault_nodes` /
  `vault_edges` over the existing notes index).
- **The face of the vault is a neurological graph** — an interactive
  force-directed brain (the user supplied an Obsidian graph-view
  screenshot as the visual reference): colored clusters by entity type/
  folder, node size by degree/recency, hover highlights the neighborhood,
  click opens the entity, double-click re-centers a local graph, search/
  filter by type/tag/time, smooth zoom-pan. Canvas/WebGL rendering
  (thousands of nodes — DOM/SVG won't hold), holo aesthetic via the
  existing theme tokens, `dataviz` skill read first. Both the user AND
  Jarvis traverse the same structure — mini-Jarvis can answer "what do I
  know about X" by walking edges, and can *show* the walk by deep-linking
  `/vault/graph?focus=<node>`.

S0 must settle at least:
1. **Structure**: folders (inbox/ projects/ people/ reference/ daily/ —
   the user's existing PARA-style layout in the screenshot is the prior),
   wikilink `[[...]]` parsing + backlinks index (extend `notes.js` index
   additively), templates, daily notes, and the **entity model**: which
   dashboard objects materialize as vault nodes, their frontmatter schema,
   and the edge types (mentions, produced-by, belongs-to-project,
   about-person, derived-from).
2. **Auto-population writers**: session/run summaries (brain `standard`
   tier, on completion — opt-in per project), chat "save to vault", the
   existing briefing notes and capture inbox route into vault structure;
   entity extraction (brain `simple` tier tags people/tools/topics →
   edges); dedupe/merge policy so the vault doesn't become a landfill.
3. **Agent navigation**: MCP tools (`vault_search`, `vault_read`,
   `vault_write`, `vault_backlinks`, `vault_neighbors`, `vault_path`
   between two nodes) so ANY spawned run can use the vault as persistent
   memory; mini-Jarvis actions get the same via §3.1's registry.
   Guardrails: writes land in inbox/ or an agent/ area by default, never
   silently overwrite human notes.
4. **Retrieval**: FTS5 is live; decide whether semantic search (local
   embeddings via Ollama on the work PC, additive vectors table) earns
   its complexity in v1 or waits.
5. **Scale/perf**: the flat-dir index → tree; watcher behavior on
   thousands of files; rebuild cost; graph-index incremental update on
   file change (the fs.watch reindex path must stay sub-second).
6. **Graph view tech**: pick the force-layout approach (d3-force on a
   canvas is the likely fit; WebGL lib only if node counts demand it —
   evaluate via Phase W findings), LOD strategy (fade labels/edges when
   zoomed out, exactly like Obsidian), and mobile interactions (pinch
   zoom, tap = focus).

S3 — graph-brain view (after S1/S2 land the index):
7. `/vault` (browse: tree + entity pages with backlinks panel) and
   `/vault/graph` (the brain). Live: `vault_changed` WS refreshes the
   local neighborhood, new nodes pulse in. Verify on desktop AND phone
   with a realistically populated vault (hundreds of nodes) — smooth pan
   at 60fps is the gate, plus "what do I know about <project>" from
   mini-Jarvis deep-linking into a focused graph.

**S landed (2026-07-05) — S0+S1+S2+S3 in one session.** S0's decisions (locked
with the user, full spec in `PLAN-jarvis-vault.md`): the vault is the umbrella
and **notes are one part of it** (the vault dir IS the notes dir; the Notes page
stays as the note-editing surface), **PARA folders**, v1 writers = **run
summaries (opt-in per project) + chat save-to-vault** (entity extraction and
briefing/capture rerouting deferred), retrieval = **FTS5 + graph traversal**
(embeddings deferred). Build: one additive `vault_edges` table; nodes are the
existing notes index with type derived from the top-level folder; wikilink
parsing rides the notes indexer via an injected hook (`notes.setVaultHooks`) —
unresolved links resolve the instant their target file appears (keys fold
spaces→hyphens so `[[Jarvis Project]]` finds `jarvis-project.md`; found live, is
a test now). `/api/vault/*` (graph, node, path, summary-projects, save-chat,
guardrailed write), `vault.attachRunSummaryWriter` on `run-spawner.onRunStatus`
(factual fallback note when the brain is down), six safe `vault_*` registry
actions + `dashboard_vault_*` MCP tools, Chat save buttons, a Settings →
Knowledge Vault opt-in card, and the `/vault` graph-brain: d3-force on canvas,
validated `--chart-1..8` type palette, hover neighborhoods, node panel with
backlinks, `?focus=` deep link, mobile pinch/pan. Verified live on a scratch
server (screenshots desktop + focus + mobile); the blank-canvas layout-feedback
bug (canvas resize ↔ scrollbar) was found in that pass and fixed by absolutely
positioning the canvas. `test:server` 733 (+14 new), `test:client` 256 (+1 new
Vault snapshot; Settings/Chat snapshots regenerated, reviewed), `mcp:typecheck`
+ `mcp:build` green. **Deferrals:** S3's 60fps-with-hundreds-of-nodes gate was
only exercised at 8 nodes (canvas + d3-force headroom is large; re-verify when
the vault is actually populated); on-device phone verification pending (mobile
verified via emulated viewport); `vault_changed` WS stays unbuilt by design
(`note_changed` covers it).

### Phase T — Phone-native extras: share inbox + glances

*One session. Independent; needs C (PWA) which is shipped.*

1. **Share-sheet target**: `share_target` in `manifest.json` (method POST,
   files+text+url) → `sw.js` intercepts → posts into the existing capture
   inbox (`assistant_captures`) / Phase-Q upload path for files → shows in
   the Tabby inbox + Notes captures banner. Re-verify current iOS PWA
   share_target support on-device first — iOS support has been shaky;
   if iOS still refuses, ship it for desktop/Android PWA and document a
   Shortcuts-based "Share to Jarvis" recipe (share sheet → Shortcut →
   `POST /api/assistant/ask` with `note:` prefix) as the iOS path — the
   endpoint already exists.
2. **Glances/widgets**: compact `GET /api/assistant/glance` (tiny JSON:
   active agents, waiting count, window %, unread notifications) behind
   the assistant bearer token; documented Shortcuts recipes for a
   home-screen widget and Watch (Shortcuts complications run shortcuts —
   honest framing: it opens/runs a Shortcut, it is not a live-updating
   native complication). Recipes in `docs/`, setup in SETUP.md.
3. Verify on-device: share a screenshot from iOS into the inbox (or via
   the Shortcut fallback), widget shows real numbers.

### Phase U — TV wall mode

*Half session. Independent.*

1. Read-only `/wall` route: no sidebar/nav, big-type instrument layout
   (core + window %, active agents, needs-you strip, GitHub reds, latest
   activity ticker), auto-cycling secondary panel, WS-live, screen-wake
   hints documented. Query params pick panels (`?panels=ops,github`).
   Desktop-guard: it must never offer mutating actions (it may be on a
   shared screen); render with a `readonly` flag that strips every action
   affordance.
2. Verify: leave it running an hour on a spare monitor; no memory creep
   (WS reconnect discipline), reconnects survive server restart.

### Phase V — Media/downloads butler skill pack

*Half session. Pure content on the shipped skills engine — cheap wins.*

1. **Subscriptions/renewals tracker**: a vault/notes ledger note
   (`reference/subscriptions.md`, structured list) + a scheduled
   `confirm: none` skill (shared scheduler) that brain-parses the ledger,
   finds renewals in the next N days, and notifies via the Phase-O facade
   (exact copy: service, amount, date) + briefing mention.
2. **Invoice/downloads organizer**: `confirm: typed` skill — shell step
   scans `~/Downloads` for invoice-ish files (pattern + brain `simple`
   classification), moves them into a configured folder tree, writes a
   summary note. Dry-run mode first (`param: dryRun` default true) that
   only reports — the destructive move requires the typed confirm AND
   dryRun=false.
3. Seed both in `docs/skills/`, document in the skills README.

### Phase W — Open-source scan (standing research thread)

*One session now; repeatable. Can run anytime — its output feeds R/S/Q.*

1. Survey targeted areas, produce a vault note + a ranked candidate list
   (the repo already has a `candidates/` dir with one entry — continue
   that pattern; clone only top candidates):
   - Assistant/companion UIs and open-source Jarvis-likes (for M/R ideas)
   - Obsidian ecosystem: auto-capture plugins, agent-vault bridges (S0
     input)
   - Claude Code skills/plugins marketplaces + awesome-lists — harvest
     skills worth porting to `~/JarvisSkills` (V-style cheap wins)
   - OpenAI-compatible gateway/adapters (Q1 shortcuts: LiteLLM et al —
     evaluate as library vs. the ~200-line own adapter; default to own,
     per repo minimal-dep culture)
   - Self-hosted push/inbox patterns (O), dashboard wall modes (U)
   - Hand-tracking/TouchDesigner integrations (backlog dossier only)
2. Each candidate gets: what it solves, license, maintenance health,
   integrate-vs-steal-ideas verdict. Findings that change a phase's
   approach get PR'd into this plan file in the same change-set.

### Phase X — Mini-Jarvis full-agent delegate (Gemini → Claude)

*LANDED 2026-07-05. Recorded here because it was built ad hoc, outside the M
sessions, and the plan is the living doc.*

The gap: a text-only brain tier (Gemini, mini-Jarvis's default) had no internet
and no multi-step agency of its own — so "Jarvis can't access the web" was
literally true for the popup's default provider. Rather than build web-search /
fetch plumbing into the server, the fix delegates: a new `claude_agent` action
hands the task to a headless `claude -p` agent that already has WebSearch,
WebFetch, the installed **agent-reach** skill (Twitter/Reddit/YouTube/GitHub/
xiaohongshu/Bilibili/RSS/arbitrary URLs), and file/shell tools — same local
binary + OAuth, no API key, free.

What shipped:
- `providers/claude.js` → `runAgentTask(task, opts)`: one-shot non-streaming
  `claude -p` spawned with `--permission-mode bypassPermissions` (headless has
  no human to approve tool use) in a **neutral home cwd** — critical: run in the
  dashboard's own dir and the child inherits *this project's* `.claude/` hooks
  (a Stop gate hijacked the first live test); home still resolves `~/.claude/
  skills` so agent-reach survives.
- `assistant-actions/registry.js` → `claude_agent` action with a **dynamic
  `risk` getter** driven by `app_settings.assistant_autonomy`
  (`off` → tool hidden from the model + `execute` refuses; `ask` → `confirm`;
  `auto` → `safe`, fires inline with no tap and non-interactive sources may fire
  it too). The one dispatcher is unchanged — the opt-in is user-owned, never a
  silent weakening. `geminiToolSpecs()` filters the tool out while `off`.
- `routes/settings.js` + `api.ts` + `Settings.tsx`: `GET/PUT /api/settings/
  assistant-autonomy` and a three-way **"Full agent"** selector under Assistant
  Access (Off / Ask first / Full access), with an amber warning on Full access.
- Tests: autonomy gating matrix (`test:server` 708 ✓, `test:client` 255 ✓);
  ARCHITECTURE ("Assistant Action Layer" + risk table) and the en locale
  updated. **Deferral:** the delegated agent's clean web fetch wasn't
  re-verified live (the sandbox classifier blocked the unsandboxed spawn) — the
  cwd fix is reasoned; confirm end-to-end by flipping to Full access and asking
  Tabby "what's the h1 on example.com".

This is the substrate the next two phases lean on: the same registry +
dynamic-risk pattern gates outbound messaging (Y), and the delegated agent is
one way to drive a browser (Z, Tier 0).

### Phase Y — Outbound messaging (Jarvis sends as me)

*One–two sessions. Depends on the §3.1 action layer + the dynamic-risk pattern
proven in Phase X. Reuses the existing webhook delivery stack.*

The ask: Jarvis sends messages for the user (incl. via Siri: "tell Jarvis to
text mum I'm late"). Decisions locked with the user: channels = **iMessage/SMS +
Slack/Discord + Email** (Telegram available for free via the same webhook path);
gating = **per-channel opt-in** (confirm by default; a Settings toggle marks
specific channels `safe` for unattended/Siri sending).

1. **Per-channel actions, not one param'd action.** The risk gate reads
   `action.risk` as a property *before* it sees params, so per-channel gating
   can't live in a single action's getter. Model one action per channel —
   `send_imessage`, `send_email`, `send_chat_message` — each with a dynamic
   `risk` getter: `safe` iff its channel key is in `app_settings.
   assistant_send_safe` (a JSON array), else `confirm`. This mirrors Phase X's
   autonomy getter and keeps the one dispatcher untouched.
2. **iMessage/SMS**: `server/lib/messaging.js` wraps `osascript` →
   Messages.app (`send … to buddy …`). SMS (green bubbles) works only if the
   user enables **Text Message Forwarding** from the iPhone to this Mac —
   surface that honestly in the Settings card, don't imply SMS works out of the
   box. Mac must be signed into iMessage.
3. **Slack/Discord/Telegram**: reuse `webhooks.deliver(target, alert)` —
   `send_chat_message({target, text})` finds a configured, enabled webhook
   target by name (`loadEnabledTargets()`) and delivers a synthetic
   text-carrying alert. Near-free; the send/retry/delivery-log machinery
   already exists. The user must have configured a webhook target first.
4. **Email**: `osascript` → Mail.app (zero new dep, works if Mail is
   configured), OR a Settings-configured SMTP transport if the user prefers.
   Own-adapter over adding nodemailer, per repo minimal-dep culture; be honest
   in the UI about which is active. `ponytail:` osascript Mail is the flaky
   ceiling — upgrade to SMTP if it misbehaves.
5. **Settings**: `GET/PUT /api/settings/send-safe-channels` + per-channel
   toggles in the Assistant Access card (peer of the "Full agent" selector).
   Default: all channels `confirm` (nothing `safe`).
6. **Siri honesty**: because sending is outward/destructive, a Siri/scheduled
   trigger is DENIED unless the user marked that channel `safe` — document this
   in `docs/jarvis-siri-shortcut.md` alongside a "text X for me" recipe.
   Recipient-level gating (safe-to-self vs anyone) is explicitly out of scope
   for v1 — channel-level only.
7. **WhatsApp is NOT in this phase** (see Backlog): no free, ToS-clean,
   send-as-me path.
8. Tests: per-channel risk-gate matrix (safe channel fires from siri; unmarked
   channel denied), osascript command construction (mock `execFile`),
   `send_chat_message` target resolution. Verify live: send yourself an iMessage
   and a Slack message from the popup; a `safe`-marked channel fires from a Siri
   Shortcut; an unmarked one is denied.

### Phase Z — Computer use (browser automation, "search this and show me")

*Two sessions: (Z1) headless browse + screenshot streaming; (Z2) optional
agentic loop. The user wants the "watch Jarvis open Chrome, search, and show me"
experience seen in other Jarvis dashboards.*

The honest catch is the **"show me"**: Chrome opens on the *Mac* (server host),
but the user is usually on their *phone*. Tiers:

- **Tier 0 — open on the Mac (LANDED 2026-07-05 as a first-class action):**
  `open_browser` (`{query?, url?}`) runs `open <url>` → the user's **real**
  default browser, logged-in session, fully interactive, **no CAPTCHA** (the Tier
  1 headless view trips DuckDuckGo's bot check and can't be clicked — that's what
  drove this). Mac-local only (shows nothing on the phone); macOS-only; same
  `assistant_browse_safe` gate as `browse`. This is what "open my Mac's browser"
  actually is — *not* Tier 2 (which is Claude driving the desktop). ~15 lines in
  the registry, no new deps. Verified live: opened the real browser to a search.
- **Tier 1 — headless browse + screenshots to the dashboard (the real ask):**
  add **Playwright** (justified dep — browser automation is not a few-lines
  job); a `browse` action / session manager navigates + searches, and each
  step's screenshot streams into a **new dashboard panel over the existing
  WebSocket** (`browse_frame` message, keep types backward-compatible). Works
  from the phone (it sees the frames). This is what the demo dashboards
  actually are. Risk `confirm` by default (it acts on the network in the user's
  name); a Settings opt-in can make read-only navigation `safe`.
- **Tier 2 — full agentic computer use (click/type loop, control the desktop):**
  Claude Computer Use / a controllable VM + screenshot→action loop. Heavy, and
  it can drive the whole machine — real safety surface. Overkill for "search and
  show me"; **backlog dossier only** unless the user asks.

Z1 spec (recommended build):
1. `server/lib/browser.js`: a Playwright session (launch, navigate, type,
   screenshot; bounded lifetime; one session at a time to start —
   `ponytail: single global session, pool later if needed`). Screenshots
   captured as data URLs / streamed as binary over WS.
2. `browse` action in the registry (`{query|url, steps?}`), risk dynamic per a
   Settings opt-in like Phase Y; the agent loop / Tabby can invoke it, and it
   deep-links to the live-view panel.
3. Client: a `/browse` panel (or a Tabby popup surface) rendering the frame
   stream, with the URL bar + the agent's narration. Mobile-friendly.
4. W (OSS scan) input: evaluate Playwright vs a browser-MCP the `claude_agent`
   could drive instead (steal-ideas vs build). Verify live on desktop AND phone:
   "search X and show me" streams frames the phone can see.

**Z1 landed (2026-07-05).** Built `server/lib/browser.js` — a single global Playwright
Chromium session (lazy-required so a missing install degrades to an honest error,
not a boot crash; auto-closed after ~2 min idle) that navigates and streams a JPEG
screenshot of every step to the dashboard over the existing WS as a `browse_frame`
message (`{url, title, image, note, at}`) — so it works from the phone, which is the
whole "show me". Added the `browse` action (`{query?, url?}`) to the registry with a
**dynamic `risk` getter** driven by `app_settings.assistant_browse_safe` (`false`
default → `confirm` one-tap; `true` → `safe`, inline for Tabby/Siri) — same pattern as
Phase X's autonomy, the one dispatcher untouched. New `GET/PUT /api/settings/browse-safe`
+ an Assistant-Access toggle ("Browse without asking"). New `/browse` page
(`client/src/pages/Browse.tsx`, sidebar nav + i18n) renders the live frame stream with a
URL bar + narration and drives the browse via the existing confirm round-trip
(`POST /api/assistant/action`); mobile-friendly. Added `playwright` dep. See
ARCHITECTURE.md → "Assistant Action Layer" (the `browse` action). `test:server` green
(713, +5 new browse-gate/URL tests); `test:client` green (255; Settings snapshot
regenerated for the new toggle). **Deferrals:** (1) Chromium itself isn't downloaded in
this session — run `npx playwright install chromium` before first live use; the code
degrades honestly until then. (2) Live verification on desktop AND phone (the phase
gate) not run here — no browser download / no phone; confirm "search X and show me"
streams frames once Chromium is installed. (3) Tier 2 (full agentic click/type loop)
stays backlog. **The optional agentic `steps` loop** (type/click/press) is wired in
`browser.js` but the `browse` action only exposes query/url today — Z2 (agentic loop)
adds the step-driving surface.

**Z tier 2 landed (2026-07-05).** User-requested pull-forward of the backlog item
(decisions locked: control the **real Mac desktop**, not a sandboxed VM/container;
risk gate is **`confirm` by default with a Settings opt-in to `safe`**, mirroring X/Z1's
dynamic-risk pattern exactly). Built `server/lib/computer-use.js` — no session/process
to manage (`ponytail:` each action is a one-shot CLI spawn, unlike Z1's persistent
Chromium page), driving `screencapture` for screenshots and macOS "System Events" UI
scripting (`osascript`) for a single left-click at a coordinate, literal keystrokes
(with AppleScript-string escaping), and named keypresses (return/tab/escape/arrows/
delete) — zero new dependencies, the same native-platform pattern as Phase Y's
osascript. Added the `computer_use` action (`{steps?}`, up to 10 of click/type/key/
screenshot; no steps = just a screenshot) to the registry with its **own** dynamic
`risk` getter driven by `app_settings.assistant_computer_use_safe` — deliberately
independent of `browse`'s opt-in (opting one in does not opt in the other, since this
one is strictly more powerful: it moves the real mouse and types on the real
keyboard). Each step screenshots and streams a `computer_use_frame` WS message
(backward-compatible addition, mirrors `browse_frame`). New `GET/PUT
/api/settings/computer-use-safe` + an Assistant-Access toggle ("Control my screen
without asking"); new `GET /api/assistant/computer-use/last` (hydrate-on-mount,
mirrors `/browse/last`). New `/computer-use` page (`client/src/pages/ComputerUse.tsx`,
sidebar nav + i18n) renders the live frame stream — no URL bar like `/browse` (you
need to see the screen before deciding where to click), just a manual "take a
screenshot" trigger plus whatever Jarvis drives via the gated action. See
ARCHITECTURE.md → "Assistant Action Layer" (the `computer_use` action).
`test:server` green (720 total, 1 skipped; +5 new tests added here: the gating
matrix mirroring `browse`'s, an independent-opt-in check, and an AppleScript-string-
escaping unit test — the 6th, a non-macOS platform-guard test, self-skips on this
darwin machine by design); `test:client` green (255; Settings snapshot regenerated
for the new toggle, reviewed).
**Deferrals:** (1) macOS Accessibility + Screen Recording permissions are required for
`osascript`/`screencapture` to work and were not granted/verified live in this session —
the code degrades to a clear stderr-sourced error either way, but "search X and show
me control it" hasn't been exercised on a real permission-granted Mac. (2) Only a
single left-click is implemented — no double-click, right-click, or drag; add if a
task needs one (documented as a `ponytail:` comment in the source). (3) The fully
autonomous vision loop (Jarvis watching every screenshot and picking its own next
click, with no pre-specified steps) needs either verified `claude -p` image input or a
provider's tool-result image feedback — both unverified elsewhere in this plan (Phase
Q1) — so it was not built; the bounded, LLM-specified step-sequence primitive is the
honest, solid piece that ships, and Tabby/Gemini can already call it turn-by-turn
within its own existing bounded tool-call loop.

### Phase AA — Content/commerce publishing (YouTube, TikTok, Etsy)

*Two sessions: (AA1) generic OAuth2 substrate + YouTube (least gated); (AA2)
TikTok + Etsy on top of it. User-requested add (2026-07-05). All three are real
via official APIs — unlike WhatsApp, no ToS gray zone — but each needs a
platform-side app registration by the user and a **new kind of auth this repo
doesn't have yet**: GitHub's integration (`server/lib/github/`) is a pasted PAT,
not an OAuth2 redirect flow. `agent-reach` explicitly excludes posting/write
actions ("NOT for: 发帖/评论/点赞等写操作"), so this is new code, not a skill
reuse.

Per-platform reality (verify exact quotas/review state at build time — these
programs change):

- **YouTube** (Data API v3, `videos.insert`): straightforward once a Google
  Cloud project + OAuth consent screen exist. Default quota is stingy — an
  upload costs ~1600 of a 10,000-unit daily budget (~6 uploads/day); a quota
  increase request is needed for more. No review gate for personal/testing use
  beyond Google's standard OAuth consent verification.
- **TikTok** (Content Posting API, TikTok for Developers): unaudited apps can
  only publish as **private/draft** or to the developer's own sandboxed
  account; public posting requires TikTok's **app review**, which takes time
  and isn't guaranteed. Build against the unaudited tier first and document the
  review step as a separate, user-driven gate.
- **Etsy** (Open API v3, listing create): OAuth2 + PKCE against an Etsy
  Developer app; creates draft or active listings directly once the user has
  an actual shop. The most straightforward of the three once the app is
  registered.

1. **Generic OAuth2 substrate** (`server/lib/oauth/`): authorization-code + PKCE
   flow, a local callback route (`GET /api/oauth/callback/:provider`),
   encrypted token storage (access + refresh) per provider, silent refresh on
   expiry. One module shared by YouTube/TikTok/Etsy (and any future OAuth
   platform) — config (client id/secret, scopes) lives in Settings like
   `github/config.js`'s pattern, but the secret is written once and never
   echoed back to the client.
2. **Actions**: `upload_youtube_video`, `post_tiktok_video`,
   `create_etsy_listing` — each `risk: "typed"` (public/irreversible publish;
   never `safe`, never mere `confirm` — this is a stronger gate than Phase Y's
   messaging, matching the stakes of a public post or a live commerce listing).
   Params carry the asset (a path inside the Phase M file allowlist, or an
   upload handed off from Phase Q's chat uploads) + title/description/tags/
   price as applicable.
3. **Settings**: an "Integrations" card per platform — connect (OAuth
   authorize button), show connection status + token expiry, disconnect. Every
   platform's free-tier/review-gate caveats surfaced honestly (mirrors the
   DeepSeek/NVIDIA honesty rule from Phase Q1).
4. **Honesty on review gates**: the TikTok public-posting gate is NOT
   something code can route around — document it plainly in the Settings card
   and in `docs/`, and default new TikTok posts to draft/private until the user
   confirms their app is audited.
5. Tests: OAuth token refresh (mocked), typed-risk gate on all three actions
   (siri/schedule denied, chat requires retype), request-building per platform
   (fixture responses, no live network in tests). Verify live: OAuth connect
   round-trip for each platform, one real draft/private upload per platform
   (never a live public post as the automated verification step).

---

## 5. Sequencing & dependency graph

```
M1 (action layer) ──── independent; DO FIRST (headline ask)
M2 (popup UI) ──────── needs M1
P  (usage piggyback) ─ independent; small — slot first or parallel with M
N  (ultron persona) ── needs M2 (+§3.3)
O  (notifications v2)─ needs M2 (popup inbox surface)
Q1 (uploads+providers) independent of M; after P for provider-registry calm
Q2 (preview) ────────── needs Q1
R1 (UX audit w/ user)─ after M2+O land (audit the new reality, not the old)
R2 (UX implement) ──── needs R1 spec
S0 (vault plan) ─────── independent planning session; before S1/S2
S1/S2 (vault build) ── needs S0; benefits from W findings
S3 (graph brain) ────── needs S1/S2 (the index it renders)
T  (share/glances) ──── independent
U  (/wall) ──────────── independent
V  (butler skills) ──── independent (engine shipped); nicer after O
W  (OSS scan) ───────── anytime; feeds S0/R1/Q1
X  (full-agent delegate) LANDED 2026-07-05; substrate for Y and Z(Tier 0)
Y  (outbound messaging) needs the §3.1 action layer + X's dynamic-risk pattern
Z  (computer use) ────── independent; Tier 0 free via X; Tier 1 adds Playwright
AA (content/commerce)── independent; needs new OAuth2 substrate (AA1 builds it)
```

Recommended order:
**P → M1 → M2 → N → O → Q1 → W → R1 → R2 → S0 → S1 → S2 → S3 → Q2 → T → V → U.**
(P first: smallest, highest-trust win — the user's top brain-dump item.
U/T/V float freely as half-session gap-fillers between big phases.)
**X landed early (out of band).** Y, Z, and AA are user-requested adds
(2026-07-05), to implement later; Y is the smaller/higher-value of the three
(mostly reuse), Z is the flashier "watch Jarvis browse" but bigger (Playwright
+ a live-view panel), AA is the biggest lift (new OAuth2 substrate + three
platforms each with their own review/quota gate — least reuse of the three).
Suggested slot: **Y before Z before AA**; all three can run independently of
the M–W spine.

## 6. Repo-wide execution rules

All of master plan §6, plus v2-specific:

- **Agency safety is one dispatcher.** Every assistant action — typed,
  spoken, scheduled, LLM-tool-called — flows through the §3.1 risk gate.
  No producer may call an action's `execute` directly.
- **Additive API evolution**: `ask` response/request changes are additive;
  Siri Shortcuts in the field must keep working unmodified.
- **Persona never trumps truth**: both personas share the honesty rules;
  Ultron changes flavor, never facts, gates, or refusal behavior.
- **Notification copy rules** (`docs/NOTIFICATIONS.md` after O) bind every
  future producer.
- **Provider capability flags, not assumptions**: vision/tools/streaming
  per provider live in the registry; UI renders from flags; unverified
  capabilities (claude -p images, envelope utilization fields, iOS
  share_target) get verified at build time and the result documented.

## 7. Backlog (not scheduled)

- **WhatsApp send** — no free, ToS-clean, send-as-me path. Options: Business
  Cloud API (free-ish tier but a *dedicated* number + Meta review + templates —
  good for notifications *to* the user, not "message my friend as me");
  whatsapp-web.js/Baileys (drives WhatsApp Web as the user's own account via QR —
  the only free send-as-me path, but **ToS violation / ban risk**, fragile,
  needs a persistent session). If ever built: an isolated, opt-in module with
  its own QR-login session, risk `typed`, and an explicit ban-risk warning. Not
  scheduled.
- **Apple Intelligence as a brain/capability** — NOT usable here. Apple's
  on-device model is only reachable via the native **Foundation Models
  framework** from a Swift app installed on-device (dev account), never from a
  Shortcut or the server; there is no general API. Siri-as-a-voice-trigger via
  Shortcuts → `/api/assistant/ask` already works and is the real integration
  (Phase Y adds the "text X for me" recipe). Revisit only if a native companion
  app is ever built (same constraint as CarPlay / Watch complications).
- **Computer use Tier 2** (full agentic desktop control — click/type loop, VM)
  — dossier only unless requested; see Phase Z. Real whole-machine safety
  surface; Tier 1 (browse + screenshots) covers the actual "search and show me"
  ask.
- **Computer vision / hand tracking / gestures** (TouchDesigner, MediaPipe)
  — explicitly deferred by the user; W collects a dossier only.
- Move the server to the 24/7 work PC (carried from master backlog).
- Wake-word desktop voice (carried).
- Per-provider spend intelligence + burn-rate forecast (carried; P's
  organic sampling makes the forecast input better).
- Native Watch complication via a tiny companion app (paid dev account —
  same constraint as CarPlay; revisit only if that changes).

---

*End of plan. Each phase names its verification gate; a phase is not done
until its gate passes — on-device for anything the user touches by phone.*
