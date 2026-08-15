# Phase 2 regression audit

- Audit date: 2026-08-15
- Recovery source: `wip/mac-2026-07-27` at `2525e9e`
- Audited branch: `dev/personal-pc` at `3a5ca4f` (pre-audit)
- Trigger: the Vault rendered a flat 2D d3 graph instead of the Three.js
  sphere, proving `PHASE-2-WIP-INVENTORY.md` recorded reconciliations that were
  never verified against the client surface.

## Method

`PHASE-2-WIP-INVENTORY.md` is treated as a claim, not as evidence. No raw
whole-repository diff was used, because that diff is dominated by intentional
cleanup. Instead:

1. File-set comparison of `2525e9e` against `HEAD`, with the inventory's
   rejected categories filtered out (`deployments/`, generated site, translated
   READMEs, IDE metadata, `graphify-out`, image/font dumps).
2. Per-file exported-symbol comparison for every shared file under
   `client/src`, `server/lib` and `server/routes`, to find behaviour that
   silently stopped being reachable.
3. Line-count deltas for each named client surface, to find large silent
   removals that keep their exports.
4. Route, lib and MCP source parity checks.
5. Direct source reads for anything the first four flagged.

## Headline finding

**Every server route, every `server/lib` module and every `mcp/src` file from
`2525e9e` survives in `HEAD`. Zero server-side losses.** All confirmed
regressions are client-side, and all follow one pattern: the backend and the
data model were reconciled, the UI that consumed them was not.

That pattern explains why the inventory looked correct. Each "Keep" row
describes server capability, and each server capability is genuinely present.

## Audit table

| Feature | WIP reference | Current equivalent | Status | Evidence | Action |
| --- | --- | --- | --- | --- | --- |
| Vault sphere renderer | `2525e9e:client/src/pages/Vault.tsx` imports `VaultSphere` (L29-30, L468) | `client/src/pages/Vault.tsx` used `d3.forceSimulation` + page-level `<canvas>` | **Confirmed regression** (fixed) | `VaultSphere.tsx` byte-identical between WIP and HEAD; `git log --all -S VaultSphere` shows only `21c2595`; `git grep -l VaultSphere` self-referencing at `21c2595`, `5702c64` and `HEAD` | Fixed in `953bbc8`; regression test `Vault.sphere.test.tsx` |
| Session provider badge | `ProviderBadge` in `2525e9e:client/src/components/StatusBadge.tsx`, used by `SessionCard.tsx` and `Sessions.tsx` | Absent; `StatusBadge.tsx` exported only `AgentStatusBadge` / `SessionStatusBadge` | **Confirmed regression** (fixed) | `Session.provider` still typed in `client/src/lib/types.ts:39-40` with the comment "currently Claude or Codex"; nothing rendered it | Fixed in `ecdc4e9`; regression test `ProviderBadge.test.tsx` |
| AgentRoom sprite + movement tests | `2525e9e:client/src/components/__tests__/AgentRoom.test.tsx` (151 lines) | `AgentRoom.test.ts` (26 lines), business-skin only | **Confirmed regression** (fixed) | `stepToward` still exported (`AgentRoom.tsx:378`) and called from the animation loop (`:949`); `TEAM` sprites still rendered; the lost suite included a named freeze-bug guard | Fixed in `ecdc4e9`; restored alongside the newer business tests |
| Codex usage client display | `CodexUsage` / `CodexUsageWindow` in `2525e9e:client/src/lib/types.ts`, consumed by `JarvisCore.tsx`, `Dashboard.tsx`, `Wall.tsx`, `api.ts` | Server side present and tested; **no client consumer** | **Confirmed regression** (not fixed - needs product decision) | `GET /api/analytics/codex` and `/codex/limits` exist (`server/routes/analytics.js:36,45`); `__formatCodexRateLimits` covered by `server/__tests__/codex-rate-limits.test.js`; no `codex` reference in `client/src/pages/Analytics.tsx` or `api.ts` | Placement is a product decision - see "Needs product decision" |
| AgentRoom sidebar + todo mining | `AgentSidebar`, `SidebarSection`, `RolePortrait`, `TodoSnapshot`, `latestTodos`, `recentToolWins` | All absent; `AgentRoom.tsx` is 425 lines smaller | **Needs product decision** | Symbol diff on `AgentRoom.tsx`; `latestTodos` has no reference anywhere in `client/src` | Ask before restoring - substantial UI surface, not a silent data break |
| AgentRoom Batcave / Ultron sprites | `BATCAVE`, `drawBatcave`, `isHangingBat`, `drawHangingSprite`, `idleSpotsFor`, `SENTINEL_IDLE_SPOTS`, `ULTRON`, `ULTRON_SCALE` | Absent from `AgentRoom.tsx`; a newer `applyRoomSkin("dev"\|"business")` system exists instead | **Needs product decision** | Symbol diff; Ultron persona still exists globally (`UltronTakeover` in `Layout.tsx`, `[data-theme="ultron"]` in `index.css`) | Cosmetic; superseded in spirit by room skins. Confirm the batcave was deliberately dropped |
| Codex provider, watcher, app-server lifecycle | Inventory `312bdc3` | `server/lib/codex-app-server.js`, `codex-watcher.js`, `providers/codex.js`, `providers/agent/codex.js`, `codex-stream-parser.js` | Present and equivalent | Server file-set parity is exact; `codex-agent`, `codex-app-server`, `codex-watcher`, `codex-rate-limits`, `codex-remote` suites all pass | None (client display tracked separately above) |
| Unified missions, scheduling, provider routing | Inventory `2e06fc5`, `61635bc` | `server/lib/missions.js`, `routes/missions.js`, `routes/schedules.js`, `lib/brain/router.js` | Present and equivalent | No lost server exports; `Missions.tsx` identical line count (857); mission-policy suites pass | None |
| Project / workspace files and MCP tools | Inventory `58373aa` | `server/lib/project-files.js`, `routes/projects.js`, `mcp/src/*` | Present and equivalent | `mcp/src` file-set parity exact; `Projects.tsx` identical (363 lines); `project-files` suite passes | None |
| Vault entity engine, Graphify, Recall | Inventory `754828f` | `server/lib/vault-engine.js`, `vault-graphify.js`, `routes/vault.js` | Present and equivalent | Server parity exact; `vault`, `vault-graphify` suites pass. Only the *renderer* regressed | None beyond the sphere fix |
| Personal / business modes, Today, briefings | Inventory `6b1fece` | `server/lib/business.js`, `routes/business.js`, `routes/briefings.js`, `pages/Today.tsx` | Present and equivalent | `Today.tsx` -1 line; business routes intact; `applyRoomSkin("business")` present with tests | None |
| Agent roster (Scout/Forge/Sentinel/Ops) | `2525e9e:.codex/agents/{scout,forge,sentinel,ops,reviewer,implementer,...}.toml` | `.claude/agents/{scout,forge,sentinel,ops}.md`; `.codex/agents/` now holds business/personal roles | Superseded by newer implementation | Matches inventory `266b1d6` exactly ("Codex mission/personal/business roles and Claude Scout/Forge/Sentinel/Ops development crew"); server test "project agent roster" asserts both halves deliberately | None |
| Agent skill definitions | `2525e9e:.agents/skills/{debug-live-issue,mcp-operations,ship-feature,update-project-docs}` | Same four under `.claude/skills/` | Superseded by newer implementation | Directory listing; contents relocated, not dropped | None |
| Subscription-only routing / billing boundaries | Inventory `61635bc` | `TIER_ORDER` in `server/lib/brain/router.js` is `codex`/`claude` only | Present and equivalent | Router comment "signed-in subscriptions only. Never cross into API-key billing or local-model routing as an implicit fallback"; no API-key or Ollama route in any tier | None - do not restore rejected routes |
| Client surfaces (Analytics, Dashboard, Missions, Projects, Run, Scheduled, Sessions, Settings, Skills, Today, Wall, Sidebar, JarvisCore, SteerPanel) | `2525e9e` equivalents | All present | Present and equivalent | Line deltas within normal churn (-61 to +44); no lost exports except the three files listed above | None |
| Enterprise deployment, generated site, translated READMEs, IDE metadata, `graphify-out` | `deployments/`, `website/`, `wiki/`, `README-CN/VN.md`, `.idea/`, root `index.html`/`sitemap.xml`/`robots.txt`/`sw.js`/`manifest.json` | Absent | Intentionally rejected | Explicitly listed in `PHASE-2-WIP-INVENTORY.md` "Reject" | None |
| `docs/DEPLOYMENT.md`, `PLAN-jarvis-business.md`, `.github/workflows/triage.yml` | Present in WIP | `DEPLOYMENT.md` at repo root; no business plan doc; no triage workflow | Superseded / intentionally rejected | `DEPLOYMENT.md` relocated to root; plan and CI triage are not runtime behaviour | None |

## Needs product decision

These change product behaviour, so they are documented rather than silently
restored.

1. **Codex usage card.** The server already serves
   `GET /api/analytics/codex` and `GET /api/analytics/codex/limits`, with the
   five-hour and weekly windows kept distinct and covered by a passing test.
   Nothing in the client consumes either endpoint, so Codex usage is invisible
   despite being collected. The WIP showed it in `JarvisCore`, `Dashboard` and
   `Wall`; `PLAN-jarvis-v3` (Phase AB1) instead specifies an Analytics card
   beside the Claude session-window ring. Those are different products.
   **Decide where it belongs before it is rebuilt.**
2. **AgentRoom sidebar and todo mining.** `latestTodos` / `recentToolWins`
   mined the newest `TodoWrite` payload into done/doing/next, rendered by
   `AgentSidebar`. It is a real feature, ~425 lines, and its absence is not a
   silent data break - nothing else references it. Restoring it is a product
   choice, not a repair.
3. **Batcave room and Ultron sprite.** Cosmetic. The newer `applyRoomSkin`
   system appears to supersede the idea. Confirm the drop was deliberate.

Nothing in this audit restores paid API routing, default local-model routing,
live business credentials, publishing, messaging or financial actions.

## Verification at audit time

| Check | Command | Result |
| --- | --- | --- |
| Client tests | `npm.cmd run test:client` | 36 files, **320/320 pass** |
| Server tests | `npm.cmd run test:server` | **940/940 pass** |
| Focused Vault tests | `npx.cmd vitest run src/pages/__tests__/Vault.sphere.test.tsx` | **2/2 pass** |
| TypeScript | `npx.cmd tsc -b --noEmit` (in `client/`) | clean, exit 0 |
| Production build | `npm.cmd run build` | success |

No pre-existing unrelated failures were observed on this branch.

## Commits from this audit

| Commit | Scope |
| --- | --- |
| `953bbc8` | Restore the Vault sphere-brain renderer |
| `ecdc4e9` | Restore the session ProviderBadge and the lost AgentRoom tests |

## Note on the inventory

`PHASE-2-WIP-INVENTORY.md` remains accurate about server capability. Its gap is
that "reconciled" was recorded per feature slice without a client-surface
check, so three UI consumers were lost while their backends passed review. Any
future reconciliation should verify the rendering path, not only the route and
the type.
