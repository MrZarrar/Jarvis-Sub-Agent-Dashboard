# Phase 5 Brain PIN Lock evidence

> Historical evidence: this records the whole-dashboard implementation introduced by commit `0c1b25e`. On 2026-08-10 the user corrected the scope to selective protection for sensitive notes and sensitive Chat answers. The replacement design and current verification are recorded in [PHASE-5-SENSITIVE-NOTES-CORRECTION.md](./PHASE-5-SENSITIVE-NOTES-CORRECTION.md). The historical statements below are intentionally preserved rather than rewritten.

- Branch: `dev/personal-pc`
- Completion date: 2026-08-09
- Master plan: `Jarvis-OS-Personal-PC-Master-Plan-2026-08-04.md`, Phase 5

No PIN, session token, dashboard token, hash, salt, or credential value is recorded here.

## Implemented boundaries

- A central server middleware defaults dashboard APIs to locked, with only health, lock bootstrap, documentation, hook ingestion, provider capability, and update bootstrap surfaces exempted.
- The PIN is exactly four digits and is persisted only as a unique-salt Node `crypto.scrypt` hash.
- Five failed attempts create a persisted 15-minute lockout.
- Unlock sessions are random per device and persisted only as SHA-256 token hashes.
- Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` behind trusted loopback HTTPS proxying, with the localhost-only HTTP exception.
- Manual lock, 1/5/15/30-minute inactivity settings, visibility/sleep recovery, API `423` handling, sensitive client-cache clearing, and lockout countdown are present.
- Protected WebSocket upgrades require the Brain session. Broadcasts recheck it and close stale sockets before sending further data.
- The locked client unmounts dashboard routes, WebSockets, notifications, search, graph, chat, and other in-memory surfaces and renders only a neutral PIN panel.
- The existing outer dashboard-token layer remains independent. Direct HUD, import-upload, chat-upload, and API traffic carries that token where required.
- The UI states explicitly that the PIN is a casual-view control and does not encrypt Windows files.

## Automated gates

| Gate | Result |
| --- | --- |
| Focused Brain-lock server suite | 10/10 passed |
| Full server suite | 914/914 passed |
| Full client suite | 285/285 passed across 33 files |
| MCP suite | 134/134 passed |
| MCP TypeScript typecheck | Passed |
| Client TypeScript and Vite production build | Passed |
| Git whitespace check | Passed before staging |

Existing non-blocking output is limited to Node SQLite experimental warnings, React Router future-flag warnings, jsdom canvas/WebGL limitations in snapshots, stale Browserslist data, and the existing Vite large-chunk advisory.

## Browser and security evidence

- Headless installed Chrome exercised a fresh per-device session at 1440 x 900 and 390 x 844.
- Locked direct API request: `423`.
- Correct synthetic test PIN: protected API `200`.
- Reload retained only the cookie-backed device session.
- Manual lock restored `423`.
- The dashboard bootstrap token was removed from the URL after capture.
- Local HTTP cookie: `HttpOnly`, `SameSite=Strict`, and not `Secure` only for the loopback development exception.
- Temporary self-signed loopback HTTPS proxy cookie: `HttpOnly`, `SameSite=Strict`, and `Secure`.
- Locked and unlocked mobile screenshots were visually inspected. The neutral lock panel was readable and contained no dashboard preview.
- The temporary HTTP server, HTTPS proxy, certificate, and private key used for browser evidence were stopped or removed after the check.

## Live machine activation

- A 64-character random dashboard token was generated into ignored machine-local `.env`; its value was neither printed nor committed.
- Live health returned `200`.
- Live Brain status without the dashboard token returned `401`.
- Live Brain status with the dashboard token returned `200`, `configured: true`, and `unlocked: false` for a fresh request without the browser cookie.
- Database metadata reported a 32-character unique salt, a 128-character scrypt hash, zero failed attempts, the configured five-minute timeout, and one per-device unlock session.
- Mushaf created the real four-digit PIN privately in the browser and confirmed that the dashboard opened. The PIN was never shared with an agent or written to evidence.

Tailscale installation, Serve configuration, real tailnet device enrolment, and production company-core deployment remain assigned to later master-plan phases. Phase 5 validated the required HTTPS and mobile security behaviour without moving those later deployment actions forward.
