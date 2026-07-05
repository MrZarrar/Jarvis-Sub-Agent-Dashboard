# Notifications (Phase O)

Every user-facing notification goes through **one facade**:
`server/lib/notify.js` → `notify({ category, title, body, url, data, source, dedupeKey, escalate })`.

It does four things at once:

1. **Persists** a row in the `notifications` table — the in-dashboard inbox
   (surfaced as a badge + Inbox tab on the Tabby ball).
2. **Broadcasts** `notification_created` on the WebSocket (live badge update).
3. **Pushes** via `push.sendPushToAll` (web push + native Electron).
4. **Respects category prefs**: a muted category (Settings → Notifications) is
   a *full* no-op — no push, no inbox row.

Never call `push.sendPushToAll` directly from a producer. The one exception is
`POST /api/push/test` (a delivery test, not a notification).

## Copy rules — every notification must be exact

A notification must answer: **what exactly, where, how bad, what do I do?**

- **Name the entity**: run directory + short id, agent name, schedule label,
  `repo#123` — never "a run", "an agent", "some PRs".
- **Carry the numbers**: exit codes, counts, durations, times.
- **Deep link to the exact entity** (`url`), not a landing page, whenever the
  entity has a page (`/run?runId=…#permission-…`, `/sessions/<id>`).
- **`data` carries entity ids** (`runId`, `sessionId`, `scheduleId`, …) so the
  inbox can render richly and future consumers don't re-parse the body.

Good: `Run failed in jarvis-dashboard` / `Run 3f2a91bc in jarvis-dashboard failed — exit 1. Tap to open the transcript.`
Bad: `Run failed` / `A run did not complete successfully.`

## Dedupe / coalesce

Pass a `dedupeKey` (`<kind>:<entity-id>`) when the same situation can repeat:
an **unread** row with the same category+key is updated in place (fresh
title/body/data/created_at) instead of stacking a near-duplicate. The update
re-pushes only when `escalate: true` — set it when each occurrence needs its
own attention (e.g. every permission request), leave it off for "still true"
repeats (e.g. an agent still waiting).

## API surface

- `GET  /api/notifications?unread=1&limit=50` → `{ notifications, unread }`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`
- WS: `notification_created` (row), `notification_read` (`{ids}` or `{all:true}`)

## Current producers

| Producer | Category | dedupeKey |
|---|---|---|
| run-spawner (permission gate) | `permission_requests` | `permission:<runId>` (escalates) |
| nudges (run failed) | `run_completions` | `run-failed:<runId>` |
| nudges (agent waiting) | `waiting_agents` | `waiting:<agentId>` |
| scheduler (fired/failed) | `scheduled_prompts` | `schedule:<id>` (escalates) |
| briefings | `briefings` | — |
| claude-swap | `account_swaps` | — |
| github poller | `github` | `github:action-needed` (escalates) |
| skills engine (notify/phone steps) | `skills` (or step category) | — |

Adding a producer: pick/add a category in `push.PUSH_CATEGORIES` (so it ships
muteable), write exact copy per the rules above, and route through the facade.
