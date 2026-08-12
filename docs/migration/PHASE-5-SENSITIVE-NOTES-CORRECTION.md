# Phase 5 selective sensitive-notes correction

- Correction date: 2026-08-10
- Automated verification date: 2026-08-12 (Europe/London)
- Branch: `dev/personal-pc-sensitive-notes`
- Original implementation: `0c1b25e` (`feat: add Brain PIN lock`)

No PIN, session token, dashboard token, hash, salt, note contents, or credential value is recorded here. All automated security fixtures use synthetic values.

## Scope correction

Commit `0c1b25e` implemented a whole-dashboard Brain gate. On 2026-08-10, the user corrected that product scope: the operational dashboard must remain usable while Brain access is locked. The replacement protects notes explicitly marked `sensitive: true`, their derived Vault/project/background data, and Chat answers that require sensitive note access. Ordinary notes and operational dashboard pages remain available.

The PIN is access control within the dashboard. It is **not encryption**: Markdown files remain plaintext to software or people with access to the Windows account and filesystem. The existing PIN hash, cookie-backed sessions, lockout, timeout, and manual/inactivity lock mechanisms remain in use.

## Current security boundary

- Missing, false, and unrecognised frontmatter values are ordinary; only the strict true marker opts a note into protection.
- Server-side Brain-cookie authentication is the only source of sensitive-read authority. Query, request-body, assistant context, MCP arguments, and forged `includeSensitive: true` values cannot grant it.
- Locked list, search, tag, capture, project, Vault, assistant, and demo/derived responses filter sensitive records before ranking, limiting, counting, graph construction, or provider output.
- Locked sensitive direct IDs and unknown IDs share the same generic not-found behavior.
- Sensitive assistant matches produce only the PIN-required discriminator. Sensitive tool output is not sent to the model/provider.
- The shared client provider leaves dashboard children mounted, owns the accessible unlock modal, and clears protected client state on manual/inactivity lock.
- Chat retains a challenged question in memory only, retries once after confirmed unlock, and discards it on cancel, failure, repeated challenge, lock transition, or unmount.
- Brain session cookies retain `HttpOnly` and `SameSite=Strict`; HTTPS requests add `Secure`, with the documented loopback HTTP development exception.

## Fresh automated matrix

The required matrix ran with Node `v22.23.2`. The first matrix invocation began `2026-08-12T22:33:00.9589119+01:00` and ended `2026-08-12T22:33:44.2962875+01:00`. MCP dependencies were initially absent, so that invocation accurately failed the MCP gates (`tsx` and `tsc` not found). `npm.cmd --prefix mcp ci --ignore-scripts` installed the committed lockfile, after which both MCP gates were rerun serially. A parallel MCP retry encountered a transient Windows `uv_os_get_passwd` `ENOMEM`; the serial required command passed.

| Gate | Fresh result |
| --- | --- |
| `npm.cmd run test:server` | Exit 0; 924/924 tests passed across 254 suites (final rerun duration 8.91 s) |
| `npm.cmd --prefix client test -- --run` | Exit 0; 311/311 tests passed across 34 files; run started 2026-08-12 22:35 local |
| `npm.cmd run build` | Exit 0; TypeScript and Vite build passed; 2,478 modules transformed |
| `npm.cmd run test:mcp` | Exit 0 after locked dependency install and serial rerun; 134/134 tests passed across 29 suites |
| `npm.cmd run mcp:typecheck` | Exit 0 after locked dependency install; `tsc -p tsconfig.json --noEmit` passed |

Non-failing output remains the existing SQLite experimental warning, React Router future warnings, jsdom canvas/WebGL snapshot limitations, stale Browserslist data, and Vite large-chunk advisory. The locked MCP dependency installation reported 9 audit findings (2 low, 3 moderate, 4 high); no dependency versions or lockfiles were changed in this task.

## Targeted synthetic security regressions

At approximately 2026-08-12 22:35 Europe/London, the following focused command exited 0 with 141/141 tests passed across 53 suites:

```powershell
node --test server/__tests__/brain-lock.test.js server/__tests__/notes.test.js server/__tests__/vault.test.js server/__tests__/projects.test.js server/__tests__/briefings.test.js server/__tests__/chat.test.js server/__tests__/assistant-actions.test.js server/__tests__/websocket.test.js
```

Together with the focused client Brain/Notes/Tabby regressions included in the 311-test client suite, these automate:

- operational REST availability and WebSocket session rechecks while locked;
- absence of sensitive canary title, ID, path, excerpt, tag, graph edge, TODO, activity fact, and count from locked surfaces;
- indistinguishable locked-sensitive and unknown direct IDs;
- rejection of forged caller-controlled sensitive-access context;
- `HttpOnly`, `SameSite=Strict`, and HTTPS `Secure` cookie attributes;
- immediate manual/inactivity lock invalidation, including deferred Notes, Vault, and Chat responses;
- exactly one Chat retry and no pending-prompt browser persistence.

## Plan trace

| Approved requirement | Implementation/test evidence |
| --- | --- |
| Strict marker and schema migration | `server/__tests__/notes.test.js`; Task 1 report |
| Notes boundary and generic not-found | `server/__tests__/brain-lock.test.js`; Task 2 report |
| Vault, projects, pulse, briefing exclusion | `server/__tests__/vault.test.js`, `projects.test.js`, `briefings.test.js`; Task 3 report |
| Assistant/MCP challenge without provider leakage | `assistant-actions.test.js`, `chat.test.js`; Task 4 report |
| Non-blocking shared provider/modal | `BrainLockGate.test.tsx`; Task 5 report |
| Notes toggle and protected-surface refresh | `Notes.sensitive.test.tsx`; Task 6 report |
| One-shot Chat retry and persistence/race handling | `TabbyPanel.test.tsx`; Task 7 report |

JS/TS response shapes use the same `pinRequired` discriminator. A source scan found no surviving caller-controlled access grant and no PIN/session/pending-prompt logging or persistence path. The placeholder scan only matched intentional TODO parsing/demo fixtures, third-party protocol schema text, and the scan command written in the approved plan; it found no implementation placeholder for this feature.

The minor verification ledger was triaged: explicit quoted-string `sensitive: "true"` reindex coverage was added; unlocked Vault node, edge, and path restoration is already asserted in `vault.test.js`. The existing briefing test exercises compute/context/compose exclusion but not the separate `runBriefing()` persistence wrapper, so that additional hardening remains deferred rather than expanding this evidence-only task.

## Browser verification status

No live browser claim is made here. Per Task 8 coordination, the controller will perform the built-client Playwright checks with synthetic fixtures at desktop and phone viewports and amend this evidence with observed results. The historical whole-dashboard browser evidence remains in its original document and does not prove the corrected selective UX.
