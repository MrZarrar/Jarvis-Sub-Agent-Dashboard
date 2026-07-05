# Jarvis glances: home-screen widget, Watch, and share-to-Jarvis (Phase T)

Phone-native extras on top of the shipped PWA and assistant API. Two pieces:

1. **`GET /api/assistant/glance`** - one compact JSON for Shortcuts-driven
   widgets and Apple Watch.
2. **Share sheet → Jarvis** - the PWA registers as a share target, so shared
   text/links land in the assistant capture inbox (the same inbox voice
   `note:` captures use), surfaced on the Notes page.

Both ride the existing plumbing - no new auth model, no new daemons.

---

## 1. The glance endpoint

```
GET /api/assistant/glance
Authorization: Bearer <assistant token>     (generate in Settings → Voice & Siri)
```

Response (all fields read-only, derived from live dashboard state):

```json
{
  "runs": { "live": 2, "waitingOnPermission": 1 },
  "agents": { "working": 3, "waiting": 1 },
  "sessions": { "active": 2 },
  "window": {
    "percentUsed": 41,
    "resetsAt": "2026-07-05T17:00:00.000Z",
    "sampleAgeMs": 180000,
    "source": "organic"
  },
  "captures": 3,
  "at": "2026-07-05T14:12:00.000Z"
}
```

- `window.*` fields are `null` until any usage sample has landed (see Phase P
  - the 5h-window cache). `resetsAt` is absolute, so a widget can compute a
  live countdown itself.
- Auth is identical to `/api/assistant/ask`: assistant bearer token for
  external callers (Shortcuts), first-party origin for the web UI. The route
  is exempt from the `DASHBOARD_TOKEN` gate for the same reason `/ask` is -
  the phone only ever carries the revocable assistant token.
- Rate limited with the same per-token bucket as `/ask`.

### Home-screen widget recipe (Shortcuts)

Honest framing first: iOS gives free apps no live-updating native widget.
What Shortcuts *can* do is a home-screen (or Watch) shortcut that fetches and
shows the numbers on demand - one tap, sub-second.

In the **Shortcuts** app, create a shortcut named **Jarvis Glance**:

1. **Get Contents of URL**
   - URL: `http://<your-tailnet-host>:4820/api/assistant/glance`
   - Method: `GET`
   - Headers: `Authorization` = `Bearer <assistant token>`
2. **Get Dictionary from Input**
3. **Text**:
   `⚙️ Runs: [runs.live] (⏳ [runs.waitingOnPermission] need you) · 🤖 [agents.working] working · 🪟 [window.percentUsed]% used`
   (insert the dictionary values with the variable picker)
4. **Show Result** (on Watch this displays on the wrist; add **Speak Text**
   instead if you prefer it spoken)

Then: long-press the home screen → add the **Shortcuts** widget → point it at
*Jarvis Glance*. On Apple Watch, enable the shortcut in **Shortcuts → Watch**
and add the Shortcuts complication - tapping it runs the glance. It *runs a
shortcut*; it is not a live-updating native complication (that needs a paid
native companion app - see the plan's backlog).

## 2. Share → Jarvis

The PWA manifest registers a `share_target`, so **Share → Jarvis** from any
app posts the shared `title`/`text`/`url` to `POST /api/share-target`, which
files it into the assistant capture inbox (`assistant_captures`, source
`share`) and lands you on the Notes page where the captures banner shows it.

- **Android / desktop Chrome**: works out of the box once the PWA is
  installed.
- **iOS**: Safari's PWA share_target support has been unreliable. If Jarvis
  doesn't appear in your share sheet, use the Shortcut fallback below - it's
  the same one-tap flow and uses an endpoint that already exists.
- **Files are not accepted yet** - the chat upload path is Phase Q1; share
  text and links today.

### iOS fallback: "Share to Jarvis" Shortcut

In the **Shortcuts** app, create **Share to Jarvis**:

1. Shortcut settings → enable **Show in Share Sheet** (accept text + URLs).
2. **Get Contents of URL**
   - URL: `http://<your-tailnet-host>:4820/api/assistant/ask`
   - Method: `POST`, Request Body: JSON
     - `text` (Text) = `note: ` + **Shortcut Input**
     - `source` (Text) = `siri`
   - Headers: `Authorization` = `Bearer <assistant token>`
3. (Optional) **Show Result** to see the "Noted." confirmation.

The `note:` prefix routes straight to the deterministic capture intent - no
LLM call, no tokens spent.
