# Task 7 report: Retry PIN-challenged Chat questions once

## Status

Implemented an in-memory protected-question flow for Mini-JARVIS. A first PIN challenge opens the shared Brain modal and, after confirmed unlock, retries the original request exactly once. The protected question is committed to the ordinary transcript only after that retry returns an ordinary response.

## Changes

- Exposed the existing `requestUnlock()` function through the safe Brain access hook, preserving its locked, non-throwing fallback for isolated renders outside the application provider.
- Added a bounded pending-question state machine to `TabbyPanel`: one initial request, one optional retry, and no recursive send path.
- Kept the pending question in React state/refs only. It is excluded from persisted conversation state until an ordinary response succeeds.
- Rendered one ephemeral user bubble while the request is pending, then replaced it with one persisted bubble on success.
- Cleared and invalidated pending work on cancel, wrong PIN, repeated challenge, request error, manual/inactivity lock revision, and unmount.
- Preserved local/offline intent behavior while committing its user and assistant messages together.

## TDD evidence

RED command:

`npm.cmd --prefix client test -- --run src/components/Tabby/__tests__/TabbyPanel.test.tsx --reporter=dot`

Initial result: exit 1, 7 failed and 6 passed. Every new Task 7 path failed because Chat did not request the shared unlock modal, retry, or withhold the pending question from transcript persistence.

During GREEN, two test prompts containing `failure` and `error` were found to match the existing offline status intent. They were changed to neutral note wording so the tests exercise the server request path rather than changing production intent matching.

GREEN focused command:

`npm.cmd --prefix client test -- --run src/components/Tabby/__tests__/TabbyPanel.test.tsx --reporter=dot`

Result: exit 0, 1 file passed, 13 tests passed.

Covering tests include:

- successful unlock retries the exact question once and renders no duplicate user bubble;
- cancel and wrong PIN clear the pending question without retry;
- a second PIN challenge stops after exactly two total requests;
- manual lock and unmount invalidate pending work;
- a thrown request clears the question and reports the error;
- storage and history spies verify the protected pending text is absent from local storage, session storage, and URL/history mutation on every terminal path and before successful retry.

Full client command:

`npm.cmd --prefix client test -- --run --reporter=dot`

Result: exit 0, 34 files passed, 309 tests passed. Existing React Router future warnings, jsdom canvas/WebGL warnings, and the browserslist-age warning remained non-failing.

Build command:

`npm.cmd --prefix client run build`

Result: exit 0; TypeScript and Vite production build passed with 2,478 modules transformed. Existing bundle-size and browserslist-age warnings remained non-failing.

Formatting command:

`npx.cmd prettier --write client/src/components/BrainLockGate.tsx client/src/components/Tabby/TabbyPanel.tsx client/src/components/Tabby/__tests__/TabbyPanel.test.tsx`

Result: exit 0; the focused test file was formatted and the production files were already compliant.

Diff command:

`git diff --check`

Result: exit 0 with no whitespace errors.

## Concerns

No new dependency, URL field, or browser-storage key was added. The initial unresolved Brain state has revision zero and is not treated as a manual lock transition; real manual/inactivity locks increment the provider revision and invalidate the pending request.

## Review fix round 1

Closed the late-response race between a Brain lock render and Tabby's passive cleanup effect. Each server send now captures the current rendered Brain state/revision and checks a synchronously refreshed access ref before consuming a response. The valid initial locked request may still receive `pinRequired`; after confirmed unlock, the retry rebases to the unlocked revision. Any later state/revision transition invalidates the initial or retry response before it can enter persisted messages.

RED command:

`npm.cmd --prefix client test -- --run src/components/Tabby/__tests__/TabbyPanel.test.tsx --reporter=dot`

Result: exit 1, 2 failed and 13 passed. A deferred ordinary initial response and a deferred retry response both remained visible when they settled during the lock transition, demonstrating that passive-effect invalidation alone was too late.

GREEN focused command:

`npm.cmd --prefix client test -- --run src/components/Tabby/__tests__/TabbyPanel.test.tsx --reporter=dot`

Result: exit 0, 1 file passed, 15 tests passed.

The two added regressions release their deferred response from a provider consumer's lock-state render, before passive effects. Both assert that neither the protected prompt nor answer reaches the transcript or browser persistence.

Full client command:

`npm.cmd --prefix client test -- --run --reporter=dot`

Result: exit 0, 34 files passed, 311 tests passed. Existing React Router, jsdom canvas/WebGL, and browserslist warnings remained non-failing.

Build command:

`npm.cmd --prefix client run build`

The first run caught incomplete test response fixtures (`speech`, `intent`, and `source` were missing). After making the fixtures mirror the API response contract, the final result was exit 0; TypeScript and Vite production build passed with 2,478 modules transformed. Existing bundle-size and browserslist warnings remained non-failing.

Formatting command:

`npx.cmd prettier --write client/src/components/Tabby/TabbyPanel.tsx client/src/components/Tabby/__tests__/TabbyPanel.test.tsx`

Result: exit 0.

Diff command:

`git diff --check`

Result: exit 0 with no whitespace errors.
