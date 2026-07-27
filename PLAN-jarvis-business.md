# PLAN — Jarvis Business Mode (Phase BM)

Business mode turns the dashboard into the ops console for Mushaf's UK
reselling business (eBay-first OA/RA; see `~/JarvisBusiness/GUIDE.md` for the
operator manual). This file is the honest ledger of what's built, what's
deliberately not built, and what a follow-up session (any model) should do
next — with file paths, so no re-discovery is needed.

## Phase BM1 — DONE (landed 11 Jul 2026, all tests green)

- [x] Work-mode store: `client/src/lib/workMode.ts` (localStorage `work-mode`,
      `useWorkMode()` hook, `work:modechange` event, `BUSINESS_WORKSPACE`).
- [x] Sidebar DEV↔BIZ switch + `BUSINESS_NAV` filter (`components/Sidebar.tsx`).
      Business nav keeps: Dashboard, Today, Agent Board, Sessions, Analytics,
      Run, Chat, Scheduled, Notes, Vault, Finance, Briefings, Settings.
      Hidden pages stay routable (focus filter, not a gate).
- [x] Separate business todo lane: `server/lib/today.js` — `mode: "business"`
      collects `- [ ]` only from notes tagged `business`; dev excludes them;
      quick-add targets a `YYYY-MM-DD Business` note (tags `daily, business`);
      Monday lanes blanked in business. Route: `GET /api/today?mode=business`,
      `POST /api/today/todos {text, mode}` (`server/routes/today.js`).
      Client callers pass mode: `pages/Today.tsx`, `components/MissionDeck.tsx`,
      `lib/api.ts`. Tests: `server/__tests__/today.test.js` ("business mode").
- [x] Home GitHub widget hidden in BIZ (`pages/Dashboard.tsx`).
- [x] Run page: server offers `~/JarvisBusiness` as a `business` cwd suggestion
      (`server/routes/run.js /cwds`, only when the dir exists); client prefers
      it as the prefill in BIZ and shows a Briefcase group (`pages/Run.tsx`,
      `cwdGroups.business` i18n key in en/tr/zh `run.json`).
- [x] Ops Room re-skin (`components/AgentRoom.tsx`): `applyRoomSkin(mode)`
      swaps display fields on the same five desks (Deal Scout / Lister /
      Underwriter / Bookkeeper + Jarvis); `roleForName` routes the business
      agent names (deal-scout, underwriter, listing-writer, cs-drafter,
      bookkeeper, ops-manager) to desks. Sprites/desks/tones unchanged.
- [x] Agent workspace `~/JarvisBusiness/`: `CLAUDE.md` (context + hard rules +
      fee cheatsheet), `AGENTS.md → CLAUDE.md` symlink (Codex-native),
      `.claude/agents/{deal-scout,underwriter,listing-writer,bookkeeper,
      ops-manager,cs-drafter}.md`, `data/deal-queue.md` seeded, `GUIDE.md`
      (full operator manual).
- [x] Docs: README feature row (Phase BM), ARCHITECTURE `/today` row.

## Owner actions — NOT code, cannot be delegated to agents

These block real operation; the guide (Part 1–2) walks through each:

- [ ] eBay Business account + business bank account + Amazon Individual
      account registration.
- [ ] Physical kit (scale, mailers) and the 3-location stock system.
- [ ] Create the three scheduled runs on `/scheduled` (morning ops brief
      07:30, evening deal sweep 18:00, Sunday close 19:00) — after ~5
      supervised manual reps of each (guide §2.4, §4.2).
- [ ] First bookkeeper session (creates `~/JarvisNotes/business/ledger.md`
      with opening capital).
- [ ] Calibration: spot-check the underwriter's first ~20 verdicts against
      real eBay sold listings before trusting BUY at a glance.

## Phase BM2 — code follow-ups, in priority order

Each item is scoped for a single session. Read the referenced files first.

- [x] **BM2a — Business briefings.** DONE (11 Jul 2026). `briefings.js`
      `assembleBusinessContext()`: included whenever `~/JarvisBusiness` exists
      (`JARVIS_BUSINESS_DIR` test seam), clearly headed `Business:` line with
      open business todos (via `today.getToday({mode:"business"})`) + unjudged
      deal-queue rows (markdown-table rows with an empty Verdict cell).
      Deterministic; "queue clear, nothing pending." when empty. Stale
      listings deliberately skipped — the ledger has no machine-readable
      listing-age field yet; add when the bookkeeper starts recording one.
      Tests: `briefings.test.js` "business context block".
- [ ] **BM2b — Session filter in BIZ.** Sessions/Agent Board show everything.
      Add a client-side filter chip "business only" (sessions whose `cwd`
      is under `~/JarvisBusiness`), default ON in BIZ mode, OFF in dev.
      Purely client-side; `Session.cwd` already exists in `lib/types.ts`.
- [ ] **BM2c — cwds test.** `server/__tests__/` has no test for the
      `business` suggestion kind. Add one: mkdir a fake home JarvisBusiness
      via env/`os.homedir` seam if feasible; if homedir can't be faked
      cleanly, test `isExistingDir` gating instead. Ten lines, not a rig.
- [ ] **BM2d — Business sprites (cosmetic, last).** Distinct pixel bodies for
      the business crew in `AgentRoom.tsx` (suit/tie Underwriter, etc.).
      Extend `BUSINESS_SKIN` to optionally carry a `sprite`; the existing
      snapshot test asserts sprite uniqueness — keep it passing.

## Built DORMANT (11 Jul 2026 — owner decision, superseding the YAGNI gate)

The user asked for the API functionality built now but switched off, so
linking accounts later is a few clicks — the v1 manual strategy stays the
default until money is made.

- **eBay / Amazon SP-API / Keepa / SellerAmp**: `server/lib/business/`
  (config + clients, injectable fetch, never throw) + `routes/business.js`
  (`/api/business/*`), Settings → Business integrations UI
  (`client/src/components/BusinessIntegrations.tsx`). Everything answers
  **503 NOT_CONNECTED** until enabled + credentialed; per-provider Test
  buttons fire one real credential check. Secrets in gitignored
  `server/config/business.json` (env fallbacks; see SETUP.md).
  Honest caveats: eBay listings are created **unpublished** (human publishes
  from Seller Hub — underwriter hard rule); eBay comps are Browse-API
  *active* listings (sold comps need the gated Marketplace Insights API);
  SellerAmp has no public API so it's a SAS lookup deep-link builder only;
  the sell-side calls are untested against a live seller account until one
  exists — run each provider's Test the day keys are pasted.
  Agent-facing endpoints documented in `~/JarvisBusiness/CLAUDE.md`.
  Tests: `server/__tests__/business.test.js`.
- **Auto-repricing**: still NOT built (nothing to reprice yet; revisit at
  >20 active listings).

## Deliberately NOT planned (YAGNI — revisit only when the trigger fires)
- **Finance-page business P&L**: the ledger in the vault is the book of
  record; the Finance page stays a subscriptions tracker. A P&L *view* only
  if weekly bookkeeper reports prove insufficient.
- **Mode-partitioned vault/notes**: explicitly rejected — vault is the shared
  second brain; partition is by the `business` tag only.
- **Business push-notification category**: wait until scheduled briefs run
  reliably; the brief IS the notification for now.

## Portability contract (Codex switch)

Keep these invariants when adding anything new, and the system stays
tool-agnostic (guide Part 5):

1. All state of record is markdown on disk (`~/JarvisBusiness`, `~/JarvisNotes`)
   — never inside a chat history, dashboard DB, or provider account.
2. Standing instructions live in `CLAUDE.md` (= `AGENTS.md` via symlink) and
   the agent `.md` files. Corrections are edited into the files, not just
   said in chat.
3. Dashboard features (Today lane, Ops Room, scheduling) are conveniences on
   top of the files, never the only way to do something — every workflow in
   GUIDE.md must remain executable with any CLI agent + a text editor.
