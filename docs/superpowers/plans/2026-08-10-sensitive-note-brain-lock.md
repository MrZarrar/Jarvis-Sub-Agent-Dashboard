# Sensitive-note Brain Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Jarvis dashboard and ordinary knowledge available while the Brain is locked, and require the existing PIN only for notes marked `sensitive: true` and answers derived from them.

**Architecture:** Markdown frontmatter remains authoritative and the rebuildable notes index mirrors sensitivity for server-side filtering. Every interactive request derives a trusted `includeSensitive` flag from the Brain cookie; locked and non-browser callers receive filtered data. A shared client Brain-session provider owns one PIN modal, while Chat handles a structured `PIN_REQUIRED` response with a single in-memory retry.

**Tech Stack:** Node.js 22, Express, SQLite/FTS, React 19, TypeScript, Vitest/Testing Library, Node test runner, WebSocket, Playwright for final browser verification.

## Global Constraints

- Never request, print, store in fixtures, or commit the real PIN, session cookie, or dashboard token.
- Protect the existing dirty worktree and unrelated user changes. Inspect `git status` before every commit and stage only files from the current task.
- Use `C:\Users\mmush\Documents\Jarvis\.tools\node-v22.23.2-win-x64` first on `Path` for all Node commands.
- Preserve the existing scrypt verifier, five-attempt lockout, Secure/HttpOnly cookie, inactivity timeout, manual lock, and per-device session semantics.
- Treat missing request context as locked. Only server-derived Brain authentication may set `includeSensitive: true`; never trust request JSON, query parameters, headers, or assistant `context` fields for this decision.
- Filter sensitive records before serialisation. Unknown notes and locked-sensitive notes must return the same generic response.
- Do not add dependencies. Keep Markdown as the source of truth and SQLite as a rebuildable local index.
- Follow strict red-green-refactor for every behavior change. Before editing tests, read the `superpowers:test-driven-development` testing guidance, including its linked good-tests guidance.
- Commit each completed task without AI attribution trailers. Do not push until all gates pass and the user has approved publication.

---

### Task 1: Persist the sensitivity marker in Markdown and the notes index

**Files:**

- Modify: `server/db.js`
- Modify: `server/lib/notes.js`
- Modify: `server/__tests__/notes.test.js`
- Modify: `client/src/lib/types.ts`

- [ ] **Step 1: Write failing persistence and compatibility tests**

Add focused cases proving that:

```js
assert.equal(created.sensitive, true);
assert.match(fs.readFileSync(created.path, "utf8"), /^sensitive: true$/m);

const edited = notes.updateNote(created.id, { title: "Renamed" });
assert.equal(edited.sensitive, true); // omitted patch preserves the marker

const ordinary = notes.createNote({ title: "Ordinary", body: "Public" });
assert.equal(ordinary.sensitive, false); // missing marker is backward-compatible
```

Also reindex a hand-written Markdown file containing `sensitive: true` and assert its SQLite row is `1`; reindex false, missing, and unrecognised values as `0`.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```powershell
$env:Path='C:\Users\mmush\Documents\Jarvis\.tools\node-v22.23.2-win-x64;'+$env:Path
node --test server/__tests__/notes.test.js
```

Expected: new assertions fail because the schema and note model do not expose `sensitive`.

- [ ] **Step 3: Add the backward-compatible SQLite migration**

Add `sensitive INTEGER NOT NULL DEFAULT 0` to the `CREATE TABLE`, then use the repository's existing column-migration pattern so pre-existing databases gain the column without recreation. Update prepared statements to insert and return it:

```js
INSERT INTO notes (
  id, path, title, tags, project_id, source, excerpt, sensitive,
  mtime, created_at, updated_at
) VALUES (
  @id, @path, @title, @tags, @project_id, @source, @excerpt, @sensitive,
  @mtime, @created_at, @updated_at
)
```

- [ ] **Step 4: Parse, serialise, and preserve the marker**

Use strict opt-in parsing so only the boolean/string value `true` unlocks sensitivity:

```js
function isSensitiveValue(value) {
  return value === true || value === "true";
}

const sensitive = isSensitiveValue(meta.sensitive);
```

Pass the marker through `buildNoteFile`, `indexFile`, `createNote`, `updateNote`, `getNote`, and row mapping. When `patch.sensitive` is `undefined`, preserve the current marker; when it is explicitly false, remove or write a false marker consistently with the existing serializer.

- [ ] **Step 5: Add the client type**

Extend both note summary and note detail shapes with:

```ts
sensitive: boolean;
```

- [ ] **Step 6: Re-run focused tests and commit**

Run the Task 1 test command. Expected: pass.

Commit:

```powershell
git -c safe.directory=C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard add server/db.js server/lib/notes.js server/__tests__/notes.test.js client/src/lib/types.ts
git -c safe.directory=C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard commit -m "feat: index sensitive note markers"
```

---

### Task 2: Make note reads selectively Brain-aware and remove the global lock

**Files:**

- Modify: `server/lib/notes.js`
- Modify: `server/routes/notes.js`
- Modify: `server/index.js`
- Modify: `server/websocket.js`
- Modify: `server/__tests__/brain-lock.test.js`
- Modify: `server/__tests__/notes.test.js`

- [ ] **Step 1: Replace whole-dashboard expectations with failing selective-access tests**

Cover these locked behaviors:

```js
assert.equal((await api.get("/api/stats")).status, 200);
assert.equal((await api.get("/api/notes")).body.notes.some(n => n.title === "Secret"), false);
assert.equal((await api.get(`/api/notes/${secretId}`)).status, 404);
assert.deepEqual(
  pick(await api.get(`/api/notes/${secretId}`), ["status", "body"]),
  pick(await api.get("/api/notes/does-not-exist"), ["status", "body"])
);
```

Also prove locked list, substring/FTS search, tag counts, captures, and project filters omit every sensitive title, path, excerpt, tag, ID, and count. With a valid test Brain cookie, prove all expected sensitive records return.

Rewrite WebSocket coverage so dashboard-token-authenticated connections succeed while Brain-locked and no event includes note metadata.

- [ ] **Step 2: Run the focused server tests and confirm failure**

Run:

```powershell
node --test server/__tests__/brain-lock.test.js server/__tests__/notes.test.js
```

Expected: operational APIs and WebSockets are still rejected, and note queries are not selectively filtered.

- [ ] **Step 3: Centralise the request-scoped policy**

Add a small server helper near the Brain Lock service:

```js
function brainAccess(req) {
  return {
    includeSensitive: brainLock.authenticate(req, { touch: false }).unlocked,
  };
}
```

Use it only server-side. Do not copy `req.body.context.includeSensitive` or any caller-controlled equivalent.

- [ ] **Step 4: Filter notes at the data boundary**

Extend note queries with locked-by-default options:

```js
function listNotes({ q = null, tag = null, projectId = null, limit = 200,
  includeSensitive = false } = {}) { /* filter before mapping */ }

function getNote(id, { includeSensitive = false } = {}) {
  const row = db.stmts.getNote.get(id);
  if (!row || (!includeSensitive && row.sensitive === 1)) return null;
  return hydrate(row);
}
```

Apply the same policy to tags, captures, dump/list helpers, project counts, and every notes-route response. Sensitive update/delete/read requires `includeSensitive`; creation may set `sensitive: true`, then returns the saved record only when the current request is unlocked.

- [ ] **Step 5: Remove broad API and WebSocket enforcement**

Delete `app.use("/api", brainLockGuard)` from `server/index.js`. Keep `/api/brain-lock` behind the dashboard token guard. Remove Brain-cookie checks from WebSocket upgrade/broadcast paths while retaining Host/origin and dashboard-token protection.

Retire `server/lib/brain-lock-middleware.js` if no import remains; otherwise narrow it to a reusable sensitive-route helper and rename it to match its role.

- [ ] **Step 6: Re-run focused tests and commit**

Run the Task 2 test command. Expected: pass.

Commit only Task 2 files with message:

```text
feat: scope Brain lock to sensitive notes
```

---

### Task 3: Remove sensitive traces from Vault, projects, and background derivations

**Files:**

- Modify: `server/lib/vault.js`
- Modify: `server/routes/vault.js`
- Modify: `server/lib/brain/pulse.js`
- Modify: `server/routes/projects.js`
- Modify: `server/__tests__/vault.test.js`
- Modify: `server/__tests__/projects.test.js`
- Modify: `server/__tests__/briefings.test.js` if briefing fixtures consume pulse output

- [ ] **Step 1: Add failing graph and derived-data tests**

Create public and sensitive notes with edges in both directions. While locked assert:

```js
assert.equal(graph.nodes.some(node => node.id === sensitiveId), false);
assert.equal(graph.edges.some(edge => edge.source === sensitiveId || edge.target === sensitiveId), false);
assert.equal(await vault.node(sensitiveId), null);
assert.equal(await vault.pathBetween(publicId, sensitiveId), null);
```

Assert backlinks/neighbours omit sensitive nodes and edges, project note counts/recent-note summaries ignore them, and pulse/briefing output contains none of their titles, excerpts, tags, TODOs, or activity facts. Repeat relevant requests with an unlocked cookie and assert interactive Vault data includes them.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
node --test server/__tests__/vault.test.js server/__tests__/projects.test.js server/__tests__/briefings.test.js
```

Expected: sensitive nodes or derived metadata leak while locked.

- [ ] **Step 3: Thread `includeSensitive` through interactive Vault reads**

Use locked defaults on all exported read functions:

```js
function graph({ includeSensitive = false } = {}) { /* ... */ }
function node(id, { includeSensitive = false } = {}) { /* ... */ }
function pathBetween(fromId, toId, { includeSensitive = false } = {}) { /* ... */ }
```

Build an allowed-node set first, then filter both nodes and every edge whose source or destination is absent. Backlinks, neighbours, path traversal, recall candidates, and direct reads must operate on that filtered set rather than filtering only their final JSON.

- [ ] **Step 4: Keep background derivation permanently locked**

Call note/Vault helpers with the default `includeSensitive: false` from pulse, recall queues, project summaries, and briefings. Do not persist sensitive-derived titles, excerpts, counts, or facts even if some unrelated browser currently has an unlocked session.

- [ ] **Step 5: Re-run focused tests and commit**

Run the Task 3 test command. Expected: pass.

Commit with message:

```text
feat: filter sensitive vault derivations
```

---

### Task 4: Return a safe structured PIN challenge from Mini Jarvis tools

**Files:**

- Modify: `server/routes/assistant.js`
- Modify: `server/lib/assistant.js`
- Modify: `server/lib/assistant-actions/index.js`
- Modify: `server/lib/assistant-actions/agent-loop.js`
- Modify: `server/lib/assistant-actions/dispatcher.js`
- Modify: `server/lib/assistant-actions/registry.js`
- Modify: `server/__tests__/assistant-actions.test.js`
- Modify: `server/__tests__/chat.test.js`
- Modify: `client/src/lib/api.ts`

- [ ] **Step 1: Add failing tool and route tests**

Test ordinary locked search, sensitive locked match, mixed public/sensitive match, exact sensitive read, unlocked search/read, and malicious client context:

```js
const response = await ask({
  message: "find the private renewal note",
  context: { includeSensitive: true }, // must be ignored
});
assert.deepEqual(response, { pinRequired: true });
assert.doesNotMatch(JSON.stringify(response), /Secret title|secret-id|match count/);
```

For a mixed query, assert `PIN_REQUIRED` wins over public matches. Assert the model/provider is never called with sensitive tool output while locked. Assert MCP/direct dispatcher calls with no trusted request context remain locked.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
node --test server/__tests__/assistant-actions.test.js server/__tests__/chat.test.js
```

Expected: tool calls either return incomplete public data or cannot signal a PIN challenge.

- [ ] **Step 3: Inject trusted Brain state at the assistant route boundary**

Derive the flag from the request and pass it separately from user context:

```js
const access = brainAccess(req);
const result = await handleAsk({
  message,
  conversationId,
  context: sanitizeClientContext(req.body.context),
  access,
});
```

Carry `access.includeSensitive` through `handleAsk`, `respond`, the agent loop, and dispatcher. Keep it outside model-editable arguments.

- [ ] **Step 4: Implement non-leaking challenge precedence**

Introduce one internal sentinel/result shape:

```js
const PIN_REQUIRED = Object.freeze({ code: "PIN_REQUIRED" });
```

Locked search handlers must determine whether a sensitive match exists without returning its rows. If so, return only the sentinel, even when public matches also exist. Exact locked-sensitive reads do the same. The agent loop stops before feeding this outcome to the model, and `/api/assistant/ask` serialises only:

```json
{ "pinRequired": true }
```

- [ ] **Step 5: Extend the client response type**

Add a discriminated response or optional field that cannot be mistaken for assistant prose:

```ts
type AssistantAskResponse =
  | { pinRequired: true }
  | { pinRequired?: false; message: AssistantMessage; actions?: AssistantAction[] };
```

- [ ] **Step 6: Re-run focused tests and commit**

Run the Task 4 test command. Expected: pass.

Commit with message:

```text
feat: challenge sensitive Jarvis queries
```

---

### Task 5: Replace the full-screen gate with a shared Brain-session provider and modal

**Files:**

- Modify: `client/src/components/BrainLockGate.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/Layout.tsx`
- Modify: `client/src/components/__tests__/BrainLockGate.test.tsx`
- Modify: `client/src/lib/__tests__/brainLock.test.ts`

- [ ] **Step 1: Write failing provider and dashboard-availability tests**

Prove that locked status still renders children, the compact control opens the modal, correct PIN resolves an unlock request, manual/inactivity lock updates state, and status failure leaves children visible:

```tsx
render(
  <BrainLockProvider>
    <div>Operational dashboard</div>
  </BrainLockProvider>
);
expect(await screen.findByText("Operational dashboard")).toBeVisible();
expect(screen.getByRole("button", { name: /unlock sensitive notes/i })).toBeVisible();
```

Test that no submitted PIN or session identifier appears in `localStorage`, `sessionStorage`, or `window.location`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
npm.cmd --prefix client test -- --run src/components/__tests__/BrainLockGate.test.tsx src/lib/__tests__/brainLock.test.ts
```

Expected: the current gate hides/unmounts children while locked.

- [ ] **Step 3: Refactor the gate into context without changing the PIN service**

Export a provider/hook contract such as:

```ts
type BrainLockContextValue = {
  state: "locked" | "unlocked" | "unavailable";
  requestUnlock: () => Promise<boolean>;
  lock: () => Promise<void>;
  timeoutMinutes: number;
  setTimeoutMinutes: (minutes: number) => Promise<void>;
};
```

Always render `children`. Render one accessible, mobile-friendly modal owned by the provider. Resolve `requestUnlock()` true only after the server confirms the cookie-backed session. Resolve false and clear callbacks on cancel, failure, lockout, unmount, or status loss.

- [ ] **Step 4: Add compact layout controls**

Keep `App` wrapped by the provider, not a blocking gate. In `Layout`, show `Unlock sensitive notes` when locked; when unlocked show the existing timeout selector and `Lock sensitive notes`. Keep connection failures local to this control/modal.

- [ ] **Step 5: Re-run focused tests and commit**

Run the Task 5 test command. Expected: pass.

Commit with message:

```text
feat: keep dashboard available while Brain locked
```

---

### Task 6: Add the `Sensitive information` toggle and refresh protected surfaces

**Files:**

- Modify: `client/src/pages/Notes.tsx`
- Modify: `client/src/pages/Vault.tsx`
- Modify: `client/src/lib/api.ts`
- Add: `client/src/pages/__tests__/Notes.sensitive.test.tsx`
- Modify: `client/src/components/__tests__/BrainLockGate.test.tsx`

- [ ] **Step 1: Add failing Notes toggle and refresh tests**

Test an accessible toggle in create/edit flows:

```tsx
expect(screen.getByRole("checkbox", { name: "Sensitive information" })).not.toBeChecked();
await user.click(screen.getByRole("checkbox", { name: "Sensitive information" }));
expect(api.notes.update).toHaveBeenCalledWith(noteId, expect.objectContaining({ sensitive: true }));
```

Prove that a newly sensitive note disappears after save if locked, appears after unlock, and disappears immediately after manual/inactivity lock. Assert Notes and Vault refetch on Brain state transitions without a page reload.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
npm.cmd --prefix client test -- --run src/pages/__tests__/Notes.sensitive.test.tsx src/components/__tests__/BrainLockGate.test.tsx
```

Expected: no toggle exists and protected surfaces do not refresh on lock-state changes.

- [ ] **Step 3: Implement the toggle and state-aware refresh**

Bind the control to draft state and send `sensitive` only when the user changes it. Existing updates that omit it must preserve the marker server-side. After save, use the server response plus Brain state to close/remove a note that is no longer visible.

Expose a monotonic `accessRevision` or equivalent provider event that changes after unlock/manual lock/inactivity lock. Key Notes and Vault fetch effects from this revision so both surfaces refetch and discard stale protected results.

- [ ] **Step 4: Re-run focused tests and commit**

Run the Task 6 test command. Expected: pass.

Commit with message:

```text
feat: add sensitive note toggle
```

---

### Task 7: Automatically retry a PIN-challenged Chat question exactly once

**Files:**

- Modify: `client/src/components/Tabby/TabbyPanel.tsx`
- Modify: `client/src/components/Tabby/__tests__/TabbyPanel.test.tsx`
- Modify: `client/src/components/Tabby/Tabby.tsx` only if provider wiring requires it

- [ ] **Step 1: Write failing automatic-retry and privacy tests**

Cover successful unlock, cancel, wrong PIN/failure, unmount, manual lock, and repeated challenge:

```ts
expect(api.assistant.ask).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: question }));
expect(requestUnlock).toHaveBeenCalledTimes(1);
expect(api.assistant.ask).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: question }));
expect(api.assistant.ask).toHaveBeenCalledTimes(2); // second PIN_REQUIRED stops
```

Spy on `localStorage.setItem`, `sessionStorage.setItem`, and history/location mutation. Assert the pending question is never persisted before successful completion and is cleared on every terminal path.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm.cmd --prefix client test -- --run src/components/Tabby/__tests__/TabbyPanel.test.tsx
```

Expected: `pinRequired` is not handled and no automatic retry occurs.

- [ ] **Step 3: Add one in-memory pending-question state machine**

Keep the protected prompt outside persisted Tabby preferences/transcript until the retry succeeds:

```ts
type PendingSensitiveQuestion = { text: string; retried: boolean };
const pendingRef = useRef<PendingSensitiveQuestion | null>(null);
```

On first `pinRequired`, retain only the original text in the ref, await `requestUnlock()`, and if true call the send path once with `repeated: true`. A second challenge, cancel, unlock failure, manual lock, unmount, or thrown request clears the ref and stops. Do not recursively call an unbounded send function.

Render an ephemeral user bubble if needed for responsiveness, but exclude it from persisted conversation state until the retry produces an ordinary response. Remove or mark unanswered on cancellation without writing the protected text to storage.

- [ ] **Step 4: Re-run focused tests and commit**

Run the Task 7 test command. Expected: pass.

Commit with message:

```text
feat: retry sensitive Chat questions after PIN
```

---

### Task 8: Correct evidence, run all gates, and perform manual browser verification

**Files:**

- Modify: `docs/migration/PHASE-5-BRAIN-LOCK-EVIDENCE.md`
- Add: `docs/migration/PHASE-5-SENSITIVE-NOTES-CORRECTION.md`
- Modify: `README.md` or operational setup documentation only where current behavior is documented

- [ ] **Step 1: Add a correction note without rewriting history**

Record that commit `0c1b25e` originally implemented a whole-dashboard Brain gate, the user corrected the scope on 2026-08-10, and the replacement protects only `sensitive: true` notes and sensitive Chat answers. State the plaintext limitation: the PIN is dashboard access control, not encryption of the Markdown files on the Windows account.

- [ ] **Step 2: Run the complete automated verification matrix**

Run from the repository root:

```powershell
$env:Path='C:\Users\mmush\Documents\Jarvis\.tools\node-v22.23.2-win-x64;'+$env:Path
npm.cmd run test:server
npm.cmd --prefix client test -- --run
npm.cmd run build
npm.cmd run test:mcp
npm.cmd run mcp:typecheck
```

Expected: every command exits `0`. Record exact counts and timestamps in the correction evidence. If any pre-existing unrelated failure appears, preserve its raw output and diagnose it before claiming completion.

- [ ] **Step 3: Run security-focused regression checks**

Using synthetic test PINs only, verify:

- locked operational REST and WebSocket behavior;
- locked list/search/tags/project/Vault/assistant/MCP responses contain no canary sensitive title, ID, path, excerpt, tag, edge, TODO, or count;
- locked-sensitive and unknown direct IDs are indistinguishable;
- a forged `includeSensitive: true` client context remains locked;
- cookie attributes remain `HttpOnly`, `Secure`, and appropriate `SameSite` over HTTPS;
- manual/inactivity lock invalidates sensitive visibility immediately.

- [ ] **Step 4: Build the served client and perform the final Playwright pass**

Use the built `client/dist` application. Check desktop and phone viewports:

1. Load the dashboard while locked and navigate operational pages.
2. Confirm ordinary Notes/Vault/Chat work.
3. Confirm the sensitive canary is absent everywhere named in the design.
4. Unlock from the compact control and confirm the canary appears.
5. Lock manually and confirm it disappears without reload.
6. Ask a sensitive Chat question while locked, enter the synthetic PIN, and confirm one automatic retry.
7. Cancel once and force a repeated challenge once; confirm neither loops or persists the pending prompt.

Do not use the real vault or real PIN for browser evidence.

- [ ] **Step 5: Self-review implementation against the approved spec**

Run:

```powershell
rg -n "TODO|TBD|FIXME|PLACEHOLDER" server client docs/superpowers
git -c safe.directory=C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard diff --check
git -c safe.directory=C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard status --short
git -c safe.directory=C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard diff --stat origin/dev/personal-pc...HEAD
```

Manually trace every design requirement to a test/evidence line, check JS/TS response shapes agree, verify no caller-controlled access flag survives, and confirm no PIN/session/pending prompt is logged or persisted.

- [ ] **Step 6: Commit the evidence and prepare publication**

Commit with message:

```text
docs: record selective Brain lock verification
```

Inspect the final commit list and diff. Ask the user before pushing the completed branch unless they already explicitly authorised the push in the current execution session.
