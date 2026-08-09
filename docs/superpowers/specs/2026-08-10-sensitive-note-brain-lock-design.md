# Sensitive-note Brain Lock design

Date: 2026-08-10
Branch: `dev/personal-pc`
Status: approved by user on 2026-08-10

## Goal

The Brain PIN protects only notes explicitly marked as sensitive and any answer derived from them. It must not lock the operational dashboard, ordinary notes, or ordinary Mini Jarvis use.

A locked sensitive note leaves no visible trace in lists, search, tags, project links, graph data, backlinks, recall, summaries, direct APIs, MCP results, or Chat tool results. When a Chat question needs sensitive context, the client asks for the PIN and automatically retries the original question once after a successful per-device unlock.

## Note marker and persistence

- Markdown remains the source of truth.
- Sensitivity is opt-in frontmatter: `sensitive: true`.
- Missing, false, or unrecognised values mean non-sensitive. Existing notes therefore remain non-sensitive.
- The rebuildable SQLite notes index gains a `sensitive` integer column with default `0`. Reindexing mirrors the frontmatter marker into that column so filtering does not require reopening every file.
- Note API types expose `sensitive: boolean` only when the caller is allowed to see that note.
- The Notes editor adds one accessible `Sensitive information` toggle.
- A user may mark a currently visible ordinary note sensitive; it disappears as soon as the save completes if the device is locked. Reading, editing, deleting, or clearing the marker on an already-sensitive note requires an active Brain session.

## Server access policy

The existing PIN hashing, failure lockout, cookie, timeout, manual-lock, and inactivity/session service remains unchanged. Enforcement becomes selective.

- Remove the global default-deny API middleware and the Brain requirement from operational WebSocket connections.
- Operational APIs, dashboard routes, notifications, and WebSocket activity remain available while the Brain is locked.
- Derive one request-scoped `includeSensitive` decision from the Brain session cookie.
- Central notes queries accept that decision and exclude sensitive rows by default. Callers must opt in with an authenticated request; absence of context is locked-by-default.
- A direct request for a sensitive note while locked returns the same generic `404` as an unknown note.
- Lists, FTS results, substring search, tag counts, project-note joins, captures, and note-derived payloads exclude sensitive rows while locked.
- Vault graph output removes sensitive nodes and every edge touching them. Node reads, backlinks, neighbours, and paths treat excluded nodes as nonexistent.
- Recall and background project pulse/briefing computations always exclude sensitive notes unless they run in an explicitly authenticated interactive request. Persisted background summaries never encode sensitive titles, excerpts, todo counts, or activity facts.
- WebSocket events may announce a neutral notes refresh, but must never include sensitive note metadata.
- MCP and non-browser callers have no Brain cookie, so they cannot retrieve sensitive notes.

The server performs filtering before serialisation. Client hiding is only a presentation layer, never the security boundary.

## Chat and PIN challenge

Mini Jarvis note and vault tools receive the request's Brain-session state through the existing dispatcher context.

While locked:

1. Ordinary searches and reads use only non-sensitive notes and continue normally.
2. If a note/vault search has any sensitive match for the query, the challenge takes precedence over public matches so Jarvis does not give a knowingly incomplete answer. An exact sensitive-node read also challenges. The tool returns a structured `PIN_REQUIRED` outcome without titles, IDs, snippets, counts, candidate names, or other existence detail.
3. The Chat API forwards that structured outcome separately from model prose. The model is never given the sensitive result.
4. The client opens the shared PIN modal immediately and retains the original user question only in memory.
5. A successful unlock automatically submits the original question once with the new cookie-backed Brain session.
6. Cancellation, unlock failure, lockout, or a second PIN challenge stops the retry and leaves the question unanswered. The client never loops.
7. The pending question and all retry state are cleared on cancellation, completion, manual lock, component unmount, and page reload. They are never written to a URL or local storage.

A PIN challenge may reveal only that protected context is required for the requested answer. It must not reveal which note matched or how many matches exist.

## Client experience

- Replace the whole-application `BrainLockGate` with a shared Brain-session provider that always renders the dashboard.
- Show a compact `Unlock sensitive notes` control in the normal layout when locked.
- The control and a Chat `PIN_REQUIRED` outcome open the same mobile-friendly PIN modal.
- When unlocked, show the current timeout selector and `Lock sensitive notes` action.
- Notes lists and Vault surfaces refresh after unlock or manual/inactivity lock so sensitive items appear or disappear immediately.
- A sensitive note shows a clear lock marker and enabled toggle only while visible in an unlocked session.
- The explicit limitation remains: the PIN controls dashboard access and does not encrypt Markdown files on the Windows account.

## Failure handling

- Brain status unavailable: keep the dashboard and ordinary data available, treat sensitive access as locked, and show a connection error only inside the unlock modal/control.
- Stale/expired session: sensitive reads revert to locked filtering; a Chat request may issue a fresh `PIN_REQUIRED` outcome.
- Incorrect PIN and five-attempt lockout retain the existing generic errors and countdown.
- Unknown and locked-sensitive note IDs remain indistinguishable through direct APIs.

## Migration and compatibility

- Existing Markdown files need no rewrite and remain non-sensitive.
- Existing PIN configuration and per-device sessions remain valid.
- Existing create clients that omit `sensitive` create non-sensitive notes. Existing update clients that omit it preserve the note's current marker.
- No new dependency is added.
- The prior Phase 5 evidence is amended by a follow-up correction note rather than rewritten as if the original whole-dashboard behaviour never shipped.

## Verification

Server tests must prove:

- operational APIs and WebSockets remain available while locked;
- sensitive frontmatter is indexed and preserved through note edits;
- locked list/search/tags/get/project/vault/graph/backlink/path/recall responses contain no sensitive metadata;
- unknown and locked-sensitive note reads are identical;
- unlocked per-device requests can retrieve sensitive notes;
- background derived data excludes sensitive notes;
- Chat tools return only structured `PIN_REQUIRED` while locked and full results while unlocked;
- MCP/direct callers cannot bypass the cookie requirement.

Client tests must prove:

- the dashboard renders while the Brain is locked;
- the toggle writes the marker and sensitive notes disappear after locking;
- manual/inactivity lock refreshes note and vault views;
- `PIN_REQUIRED` opens the modal;
- successful PIN entry retries the original question exactly once;
- cancellation, failure, or a repeated challenge never retries indefinitely;
- no PIN, session token, or pending sensitive question enters URL or local storage.

Browser checks cover desktop and phone layouts, ordinary dashboard use while locked, sensitive-note disappearance, PIN unlock, automatic Chat retry, manual lock, refresh, and HTTPS cookie attributes.
