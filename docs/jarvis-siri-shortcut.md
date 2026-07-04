# Jarvis — Siri Shortcut recipe (Phase D)

A machine-readable description of the "Jarvis" Siri Shortcut that gives you
hands-free, two-way voice control of the dashboard from your iPhone or CarPlay.
The Shortcut dictates a request, POSTs it to `POST /api/assistant/ask` over the
tailnet, and speaks the `speech` field of the reply.

> **Why there's no binary `.shortcut` file here.** Apple signs exported
> `.shortcut` files per iCloud account, and a shortcut that performs a network
> request cannot be authored or signed off-device. So this repo ships the recipe
> (below) rather than a fake binary. Build it once in the Shortcuts app with these
> steps, then **Share → Export** if you want your own signed backup. This is the
> honest tradeoff called out in `PLAN-jarvis-master.md` §Phase D / constraints.

See [`SETUP.md` → "Voice control via Siri Shortcuts"](../SETUP.md#voice-control-via-siri-shortcuts-phase-d)
for the full walkthrough (token generation, Tailscale reachability, CarPlay).

## Prerequisites

- The dashboard is reachable over the tailnet (see SETUP → Remote access) and
  your tailnet hostname is in `DASHBOARD_ALLOWED_HOSTS`.
- A bearer token generated in **Settings → Voice & Siri** (copied at creation —
  it is shown only once).

## Actions

```jsonc
{
  "name": "Jarvis",
  "actions": [
    { "type": "DictateText", "output": "DictatedText", "language": "en-US" },
    {
      "type": "GetContentsOfURL",
      "url": "https://my-pc.tailnet-name.ts.net/api/assistant/ask",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer <YOUR_ASSISTANT_TOKEN>",
        "Content-Type": "application/json"
      },
      "requestBody": {
        "type": "json",
        "fields": {
          "text": "{{DictatedText}}",
          "source": "siri",
          "conversationId": "car"
        }
      },
      "output": "Response"
    },
    { "type": "GetDictionaryValue", "key": "speech", "from": "{{Response}}", "output": "Speech" },
    { "type": "SpeakText", "text": "{{Speech}}", "waitUntilFinished": true }
  ],
  "optionalMultiTurn": [
    { "type": "AskForInput", "prompt": "Anything else?", "output": "FollowUp" },
    { "type": "If", "condition": "FollowUp is not empty",
      "then": "Repeat GetContentsOfURL with text={{FollowUp}} and the same conversationId=car, then SpeakText the new speech." }
  ]
}
```

## Request / response contract

**Request** — `POST /api/assistant/ask`

| Field | Required | Notes |
|---|---|---|
| `text` | yes | The dictated/typed request |
| `source` | no | `siri` \| `carplay` \| `chat` \| `notes` \| `quickaction` (default `chat`) |
| `conversationId` | no | Opaque id (≤128 chars) threading multi-turn context |
| `speak` | no | Advisory hint; `speech` is always returned |

Header: `Authorization: Bearer <token>` (or `x-assistant-token: <token>`).

**Response** — `{ text, speech, intent, source, conversationId, ... }`

- `text` — full answer.
- `speech` — short, markdown-free, number-rounded variant to read aloud. **This
  is the field the Shortcut speaks.**
- `intent` — which deterministic intent handled it (`status`, `kill`, `steer`,
  `note`, `run_skill`, or `chat` when it fell through to the brain).

## Voice intents

| Say | Effect |
|---|---|
| `status` | Live runs / waiting agents / active sessions |
| `kill all` or `kill <run>` | Stop a dashboard-spawned run (only `kill all` stops more than one) |
| `steer <run> <message>` | Send a follow-up into a live conversation run |
| `note: <text>` | Capture a brain dump to the inbox (filed by Phase G Notes) |
| `run skill <name>` | Reserved for Phase H |
| anything else | The mini-Jarvis brain (a stub until Phase G) |

## Errors

- `400` — `text` missing/empty.
- `401` — missing/invalid token. Generate a new one in Settings → Voice & Siri.
- `429` — rate limited (default 60/min per token); honor the `Retry-After` header.
