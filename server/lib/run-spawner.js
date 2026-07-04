/**
 * @file run-spawner.js
 * @description Spawns and supervises Claude Code subprocesses for the
 * dashboard's Run page. Two modes:
 *   - "headless"     - single-shot. Stdin is closed after spawn; the prompt
 *                      lives in argv via `-p`. Process exits when the model
 *                      finishes the turn.
 *   - "conversation" - multi-turn. Stdin stays open; follow-up turns are
 *                      delivered via JSON envelopes through stdin and the
 *                      caller can pipe more messages until they kill or the
 *                      child exits naturally.
 *
 * Conversation mode also supports resuming an existing session via
 * `--resume <session-id>`, so the user can continue any prior Claude Code
 * conversation from inside the dashboard.
 *
 * Output is always `--output-format stream-json --verbose` so the parser can
 * deliver structured envelopes (system/init, assistant text+tool_use, user
 * tool_result, result/success, etc). Each envelope is broadcast over the
 * dashboard's existing WebSocket as a `run_stream` message; status changes
 * (spawning → running → completed/error/killed) broadcast as `run_status`.
 *
 * Concurrency is capped (RUN_MAX_CONCURRENT, default 10) - over the cap we
 * throw ECONCURRENCY with the running set so the route can return 429.
 *
 * Each handle keeps a bounded in-memory envelope log (cap 500) so a client
 * that attaches late can replay what it missed. Completed handles are reaped
 * after 5 min - but the underlying transcripts persist via the normal hook
 * ingestion pipeline (every spawned `claude` fires hooks like any other
 * session, so the run shows up in /sessions automatically).
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { broadcast } = require("../websocket");
const { createLineParser } = require("./stream-json-parser");
// Agentic provider registry (Phase E, §E2). "claude" is the default and keeps
// byte-identical behavior; "gemini-cli" is a second spawnable backend with its
// own argv + stream parser and NO permission gate.
const { getAgentProvider, DEFAULT_AGENT_PROVIDER } = require("./providers/agent");

// Env var names shared with scripts/permission-gate.js (the second PreToolUse
// hook). They MUST stay in sync with that file. When a run opts into
// interactive permissions, we set these on the spawned child's env; the gate
// hook reads them to know which dashboard + run to ask for an allow/deny
// decision. Absent them, the gate is a no-op (see permission-gate.js).
const ENV_INTERACTIVE_RUN_ID = "JARVIS_INTERACTIVE_PERMISSIONS";
const ENV_DASHBOARD_PORT = "JARVIS_DASHBOARD_PORT";

// Persistence is best-effort and optional - load lazily so unit tests that
// don't bring up the full db can still exercise the spawner.
let dashboardRuns = null;
try {
  dashboardRuns = require("./dashboard-runs");
} catch {
  /* db-less environment, skip persistence */
}
function recordRun(handle) {
  if (dashboardRuns) dashboardRuns.recordRun(handle);
}
function patchRun(args) {
  if (dashboardRuns) dashboardRuns.patchRun(args);
}

// Same lazy, best-effort pattern as dashboardRuns above - a pending
// permission request must stay loud even if push (or its `web-push` dep)
// isn't available in this environment.
let pushLib = null;
try {
  pushLib = require("./push");
} catch {
  /* push lib unavailable - skip the push leg, WS broadcast still fires */
}

/** Fire a web-push notification for a newly-opened permission request, deep
 *  linking to the Run page so a tap lands directly on the Allow/Deny card
 *  (client/src/pages/Run.tsx's `?runId=` + `#permission-<id>` handling). */
function notifyPermissionRequest(runId, entry) {
  if (!pushLib) return;
  try {
    const { db } = require("../db");
    const title = "Permission needed";
    const body = `${entry.toolName} wants to run - tap to review`;
    const url = `/run?runId=${encodeURIComponent(runId)}#permission-${encodeURIComponent(entry.requestId)}`;
    // Tagged so the Settings "permission requests" category switch can silence
    // it server-side (routes/push.js). Muted → sendPushToAll is a no-op.
    pushLib.sendPushToAll(db, title, body, url, "permission_requests").catch(() => {});
  } catch {
    /* db unavailable (e.g. some unit test environments) - WS still covers it */
  }
}

// Effectively uncapped - claude's terminal TUI doesn't gate concurrent
// sessions, so we don't either. The number is high enough that a buggy
// client still can't fork-bomb the host before someone notices, but low
// enough that no human will ever hit it organically. Users who want a
// real cap can set RUN_MAX_CONCURRENT.
const MAX_CONCURRENT_DEFAULT = 10000;
const REAP_AFTER_MS = 5 * 60 * 1000; // keep handle for 5 min after exit
const STDOUT_TAIL_BYTES = 4 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;
// Cap stored envelopes per handle so a long-running conversation doesn't
// balloon memory. Late-attaching clients get this much history; the full
// transcript is always available via the existing /sessions/<id> view.
const MAX_ENVELOPES_PER_HANDLE = 500;
// Inline base64 images (screenshots, Read-on-image tool results) can be huge -
// measured ~4MB base64 for a single incompressible 1280x800 PNG. The 500-envelope
// cap above bounds *count*, not bytes, so a screenshot-heavy run (e.g. computer-use)
// could still balloon the in-memory replay buffer toward gigabytes. Keep only the
// most recently seen N images at full resolution; older ones are nulled out in
// place. This never touches what already went out over the live WebSocket
// broadcast - it only bounds what a late-attaching client replays.
const MAX_STORED_IMAGES_PER_HANDLE = 20;
const IMAGE_OMITTED_NOTE =
  "omitted from replay buffer (history limit) - see the live stream or session transcript";

// Server-side safety net for orphaned permission requests. The gate hook
// enforces its own 10-minute hard cap and denies on timeout, so under normal
// operation the hook resolves every request. This slightly-longer TTL only
// catches entries the hook abandoned (e.g. its process was killed before it
// could deny) - such an entry auto-resolves to "deny" on the next poll or
// listing so the UI never shows a request that can never complete. Fail
// toward safety: expiry denies, never allows (CLAUDE.md).
const PERMISSION_REQUEST_TTL_MS = 11 * 60 * 1000;

const handles = new Map();
const reapers = new Map();

// ── Run-status subscribers (Phase L) ────────────────────────────────────────
// The scheduler (server/lib/scheduler.js) subscribes here to fire
// `on_run_complete` schedules the instant a watched run reaches a terminal
// status. Kept generic and fail-safe: a throwing subscriber can never break a
// run's teardown. Terminal statuses only ("completed" | "error" | "killed").
const statusListeners = new Set();

function onRunStatus(cb) {
  if (typeof cb === "function") statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function emitTerminalStatus(handle) {
  if (!handle) return;
  const payload = {
    id: handle.id,
    status: handle.status,
    exitCode: typeof handle.exitCode === "number" ? handle.exitCode : null,
    sessionId: handle.sessionId || null,
    cwd: handle.cwd || null,
    model: handle.model || null,
    at: handle.endedAt || Date.now(),
  };
  for (const cb of statusListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.warn("[run-spawner] status listener threw:", err?.message || err);
    }
  }
}

function getMaxConcurrent() {
  const raw = process.env.RUN_MAX_CONCURRENT;
  if (!raw) return MAX_CONCURRENT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : MAX_CONCURRENT_DEFAULT;
}

function liveCount() {
  let n = 0;
  for (const h of handles.values()) {
    if (h.status === "spawning" || h.status === "running") n++;
  }
  return n;
}

function tail(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

/**
 * Build argv for the `claude` invocation. The two modes have different argv
 * shapes because of how Claude Code resolves the first user message:
 *
 *   - HEADLESS: `-p "<prompt>"` carries the prompt; stdin is closed; Claude
 *     processes one turn and exits.
 *   - CONVERSATION: `--input-format stream-json` puts Claude in multi-turn
 *     mode where ALL user turns (including the first) come via stdin. When
 *     stream-json input is enabled, `-p` is silently ignored - so we OMIT
 *     it and send the initial prompt over stdin in `spawnRun` immediately
 *     after the spawn handshake.
 */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function buildArgv({ prompt, mode, model, permissionMode, resumeSessionId, effort }) {
  const argv = [];
  argv.push("--output-format", "stream-json");
  argv.push("--verbose");
  // Real character-by-character streaming. Without this flag Claude only
  // emits the *final* assistant envelope, which makes the UI feel like the
  // response arrives all at once. With it, we also receive `stream_event`
  // envelopes (Anthropic Messages API streaming events) so the UI can
  // render text + thinking deltas as they arrive.
  argv.push("--include-partial-messages");
  argv.push("--permission-mode", permissionMode || "acceptEdits");
  if (mode === "headless") {
    argv.push("-p", prompt);
  } else {
    argv.push("--input-format", "stream-json");
  }
  if (model) {
    argv.push("--model", model);
  }
  if (effort && EFFORT_LEVELS.has(effort)) {
    // Drives thinking depth: higher = more reasoning tokens before the
    // assistant turn. Empty / unset means "inherit from the model's default".
    argv.push("--effort", effort);
  }
  if (resumeSessionId) {
    argv.push("--resume", resumeSessionId);
  }
  return argv;
}

/**
 * Frame a stream-json user envelope. Used both for the initial conversation-
 * mode prompt and for follow-up turns via sendInput.
 */
function userEnvelope(text, id) {
  const e = {
    type: "user",
    message: { role: "user", content: text },
  };
  if (id) e.id = id;
  return JSON.stringify(e) + "\n";
}

/**
 * Strip dashboard-internal env vars from the child so the spawned `claude`
 * doesn't accidentally pick up our hook-handler context (and to keep the
 * child's auth entirely from the user's existing OAuth in $HOME).
 *
 * When `interactiveRunId` is set, ALSO inject the two env vars the
 * permission-gate hook keys off - this is the ONLY path that arms the gate,
 * so a plain terminal session (which never sees these vars) is completely
 * unaffected. We always delete them first so a nested dashboard-inside-
 * dashboard spawn can't leak a parent run's id into a child that didn't ask
 * for interactive permissions.
 */
function cleanSpawnEnv(interactiveRunId) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete env[ENV_INTERACTIVE_RUN_ID];
  delete env[ENV_DASHBOARD_PORT];
  if (interactiveRunId) {
    env[ENV_INTERACTIVE_RUN_ID] = interactiveRunId;
    // Point the gate at THIS dashboard specifically. Fall back to the
    // discovery file only if the server hasn't recorded its port yet.
    let port = null;
    try {
      port = require("./server-info").getOwnPort();
      if (!port) port = require("./server-info").resolveDashboardPort();
    } catch {
      /* discovery unavailable - leave unset; gate falls back to its own default */
    }
    if (port) env[ENV_DASHBOARD_PORT] = String(port);
  }
  return env;
}

function isInlineImageBlock(b) {
  return (
    b &&
    typeof b === "object" &&
    b.type === "image" &&
    b.source &&
    typeof b.source === "object" &&
    b.source.type === "base64" &&
    typeof b.source.data === "string"
  );
}

/**
 * Walk the handle's current envelope buffer newest-first and null out the
 * base64 `data` of any inline image beyond the most recent
 * MAX_STORED_IMAGES_PER_HANDLE - bounding replay-buffer memory regardless of
 * how many screenshots a run produces. O(bounded envelope count) per call;
 * only ever touches envelopes still sitting in the in-memory buffer.
 */
function capStoredImages(handle) {
  let seen = 0;
  for (let i = handle.envelopes.length - 1; i >= 0; i--) {
    const env = handle.envelopes[i];
    const content = env && env.type === "user" && env.message && env.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        if (!isInlineImageBlock(inner) || inner.source.data === null) continue;
        seen += 1;
        if (seen > MAX_STORED_IMAGES_PER_HANDLE) {
          inner.source.data = null;
          inner.source._omitted = IMAGE_OMITTED_NOTE;
        }
      }
    }
  }
}

function attachStreamHandlers(handle) {
  // Claude (default) uses the raw line parser; other backends (gemini-cli)
  // supply a parser that normalizes their stream into the same envelopes.
  const makeParser = handle.createParser || createLineParser;
  const parser = makeParser(
    (envelope) => {
      // First parsed envelope means the child is producing output → "running".
      if (handle.status === "spawning") {
        handle.status = "running";
        broadcast("run_status", { id: handle.id, status: "running", at: Date.now() });
        patchRun({ id: handle.id, status: "running" });
      }
      // Capture session_id off the system/init envelope - once we have it the
      // dashboard can deep-link to /sessions/<id> on completion.
      if (
        envelope &&
        envelope.type === "system" &&
        envelope.subtype === "init" &&
        typeof envelope.session_id === "string"
      ) {
        const wasNull = !handle.sessionId;
        handle.sessionId = envelope.session_id;
        if (wasNull) patchRun({ id: handle.id, sessionId: envelope.session_id });
      }
      handle.envelopeCount += 1;
      handle.envelopes.push(envelope);
      // Keep only the most recent N - older entries are still in the disk
      // transcript at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl,
      // visible via the regular /sessions/<id> dashboard view.
      if (handle.envelopes.length > MAX_ENVELOPES_PER_HANDLE) {
        handle.envelopes.splice(0, handle.envelopes.length - MAX_ENVELOPES_PER_HANDLE);
      }
      broadcast("run_stream", { id: handle.id, envelope });
      // Mutates only envelopes already broadcast above - never the live wire.
      capStoredImages(handle);
    },
    (err, raw) => {
      handle.stderrBuffer += `[parse-error] ${err.message}: ${raw}\n`;
    }
  );

  handle.child.stdout.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    handle.stdoutBuffer = tail(handle.stdoutBuffer + s, STDOUT_TAIL_BYTES);
    parser.push(s);
  });
  handle.child.stderr.on("data", (chunk) => {
    handle.stderrBuffer = tail(handle.stderrBuffer + chunk.toString("utf8"), STDERR_TAIL_BYTES);
  });
  handle.child.on("error", (err) => {
    handle.status = "error";
    handle.error = err.message;
    handle.endedAt = Date.now();
    denyAllPending(handle, "run errored");
    broadcast("run_status", {
      id: handle.id,
      status: "error",
      error: err.message,
      at: handle.endedAt,
    });
    patchRun({ id: handle.id, status: "error", endedAt: handle.endedAt });
    emitTerminalStatus(handle);
    scheduleReap(handle.id);
  });
  handle.child.on("exit", (code, signal) => {
    parser.flush();
    // Resolve any request a hook is still polling on so it exits with the
    // process instead of waiting out its timeout (no-op if none are open).
    denyAllPending(handle, "run ended");
    if (handle.status === "killed") {
      // already broadcast - patchRun already happened in stop()
    } else {
      handle.status = code === 0 ? "completed" : "error";
      handle.exitCode = code;
      handle.signal = signal;
      handle.endedAt = Date.now();
      broadcast("run_status", {
        id: handle.id,
        status: handle.status,
        exitCode: code,
        sessionId: handle.sessionId || null,
        at: handle.endedAt,
      });
      patchRun({
        id: handle.id,
        status: handle.status,
        exitCode: code,
        sessionId: handle.sessionId || null,
        endedAt: handle.endedAt,
      });
    }
    // Notify status subscribers for BOTH the natural exit and the earlier kill
    // path (killRun set status to "killed" and returned; the child's exit lands
    // here). Fires exactly once per run since exit fires once.
    emitTerminalStatus(handle);
    scheduleReap(handle.id);
  });
}

function scheduleReap(id) {
  const existing = reapers.get(id);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    handles.delete(id);
    reapers.delete(id);
  }, REAP_AFTER_MS);
  // Don't keep the process alive just for the reap timer.
  if (typeof t.unref === "function") t.unref();
  reapers.set(id, t);
}

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {"headless"|"conversation"} args.mode
 * @param {string} [args.cwd]
 * @param {string} [args.model]
 * @param {string} [args.permissionMode]
 * @param {"auto"|"interactive"} [args.permissionUx] "interactive" arms the
 *   permission-gate hook for this run so each tool call awaits an explicit
 *   dashboard allow/deny. Anything else (the default) leaves the gate a no-op.
 * @returns handle
 */
function spawnRun(args) {
  const {
    prompt,
    mode,
    cwd,
    model,
    permissionMode,
    resumeSessionId,
    effort,
    permissionUx,
    projectId,
  } = args || {};
  const provider = (args && args.provider) || DEFAULT_AGENT_PROVIDER;
  if (typeof prompt !== "string") {
    throw makeErr("EBADPROMPT", "prompt is required");
  }
  // Empty prompt is allowed only when resuming a conversation - claude
  // idles on the resumed transcript until the user types a follow-up.
  if (!prompt.trim() && !(mode === "conversation" && resumeSessionId)) {
    throw makeErr("EBADPROMPT", "prompt is required");
  }
  if (mode !== "headless" && mode !== "conversation") {
    throw makeErr("EBADMODE", `mode must be "headless" or "conversation"`);
  }
  if (effort != null && effort !== "" && !EFFORT_LEVELS.has(effort)) {
    throw makeErr("EBADEFFORT", `effort must be one of: ${Array.from(EFFORT_LEVELS).join(", ")}`);
  }
  if (resumeSessionId != null) {
    if (typeof resumeSessionId !== "string" || !/^[A-Za-z0-9-]{8,}$/.test(resumeSessionId)) {
      throw makeErr("EBADSESSION", "resumeSessionId is not a valid session id");
    }
    // Resume only makes sense in conversation mode (you want to keep talking).
    // Headless `claude --resume` does run, but the UX of "send one prompt and
    // exit" on a resumed session is confusing - disallow.
    if (mode !== "conversation") {
      throw makeErr("EBADMODE", "resumeSessionId requires conversation mode");
    }
  }
  // Resolve the agentic backend. Unknown provider is a hard error; capability
  // gaps (gemini-cli has no resume) fail loudly rather than silently degrading.
  const agent = getAgentProvider(provider);
  if (!agent) {
    throw makeErr("EBADPROVIDER", `unknown run provider: ${provider}`);
  }
  if (resumeSessionId && !agent.supportsResume) {
    throw makeErr("EBADPROVIDER", `${provider} does not support resuming a session`);
  }
  const max = getMaxConcurrent();
  if (liveCount() >= max) {
    const err = makeErr("ECONCURRENCY", `concurrency limit ${max} reached`);
    err.running = Array.from(handles.values())
      .filter((h) => h.status === "running" || h.status === "spawning")
      .map((h) => ({ id: h.id, pid: h.pid, startedAt: h.startedAt, mode: h.mode }));
    throw err;
  }

  const id = randomUUID();
  // The interactive permission gate is Claude-only (PreToolUse hook). A
  // gemini-cli run can never arm it - force auto so the UI never implies a
  // Gemini run has an allow/deny gate it doesn't.
  const interactive = permissionUx === "interactive" && agent.supportsPermissionGate;
  // Backends that don't do multi-turn stdin (gemini-cli v1) run headless
  // regardless of the requested mode.
  const effectiveMode = agent.supportsConversation ? mode : "headless";
  // Interactive permissions means "a human approves every tool call", so the
  // run MUST use "default" mode: any auto-accepting mode (acceptEdits) or a
  // bypass mode would let some tools through without ever reaching the gate,
  // silently defeating the feature. Force "default" whenever interactive;
  // otherwise honour the caller's choice (defaulting to acceptEdits as before).
  const effectivePermissionMode = interactive ? "default" : permissionMode || "acceptEdits";

  // Claude keeps its exact historical argv/command/parser (byte-identical, per
  // run.test.js). Other backends supply their own via the adapter.
  let command;
  let argv;
  let createParser;
  if (provider === DEFAULT_AGENT_PROVIDER) {
    command = "claude";
    argv = buildArgv({
      prompt,
      mode: effectiveMode,
      model,
      permissionMode: effectivePermissionMode,
      resumeSessionId,
      effort,
    });
    createParser = null; // run-spawner default (createLineParser)
  } else {
    command = agent.command;
    argv = agent.buildArgv({ prompt, mode: effectiveMode, model, cwd, effort });
    createParser = agent.createParser;
  }

  const child = spawn(command, argv, {
    env: cleanSpawnEnv(interactive ? id : null),
    cwd: cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Resolve the Project this run belongs to (Phase F): an explicit projectId
  // wins, otherwise fall back to a cwd → project_paths prefix match. Resolved
  // once here (not left to dashboard-runs.js) so the live in-memory handle -
  // not just the persisted row - reflects the same association immediately.
  let resolvedProjectId = null;
  try {
    resolvedProjectId = require("./projects").resolveProjectId({
      explicitId: projectId,
      cwd: cwd || process.cwd(),
    });
  } catch {
    /* association is a side benefit, never a blocker */
  }

  const handle = {
    id,
    pid: child.pid || null,
    provider,
    mode: effectiveMode,
    cwd: cwd || process.cwd(),
    model: model || null,
    permissionMode: effectivePermissionMode,
    permissionUx: interactive ? "interactive" : "auto",
    effort: effort || null,
    projectId: resolvedProjectId,
    prompt,
    argv,
    createParser,
    resumeSessionId: resumeSessionId || null,
    status: "spawning",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    sessionId: resumeSessionId || null, // optimistic; will be confirmed by system/init envelope
    envelopeCount: 0,
    envelopes: [],
    // Per-run interactive-permission requests, keyed by requestId (== the
    // tool_use_id from the hook). Ephemeral, scoped to the handle's life,
    // matching how live run state is kept here.
    permissions: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    child,
  };
  handles.set(id, handle);
  recordRun(handle);

  attachStreamHandlers(handle);

  if (effectiveMode === "headless") {
    // Headless: prompt is in argv; close stdin so Claude knows nothing more
    // is coming and exits after the one turn.
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  } else if (prompt && prompt.trim()) {
    // Conversation: deliver the initial prompt over stdin so Claude in
    // stream-json input mode actually starts processing it. Stdin stays
    // open for follow-up turns.
    try {
      child.stdin.write(userEnvelope(prompt));
    } catch (err) {
      handle.stderrBuffer += `[stdin-write-error] ${err.message}\n`;
    }
  }
  // Conversation with empty prompt (resume scenarios) - leave stdin open;
  // claude will idle on the resumed conversation until the user types a
  // follow-up via POST /:id/message.

  broadcast("run_status", { id, status: "spawning", at: handle.startedAt });
  return handle;
}

/**
 * Send a follow-up user turn into a running conversation. Throws if the
 * handle is not running, not in conversation mode, or stdin is closed.
 */
function sendInput(id, text) {
  const handle = handles.get(id);
  if (!handle) throw makeErr("ENOTFOUND", "run not found");
  if (handle.mode !== "conversation") {
    throw makeErr("EWRONGMODE", "only conversation mode accepts follow-up input");
  }
  if (handle.status !== "running" && handle.status !== "spawning") {
    throw makeErr("ENOTRUNNING", `run is ${handle.status}`);
  }
  if (typeof text !== "string" || !text) {
    throw makeErr("EBADINPUT", "text is required");
  }
  if (!handle.child || !handle.child.stdin || !handle.child.stdin.writable) {
    throw makeErr("ESTDINCLOSED", "stdin is not writable");
  }
  const messageId = randomUUID();
  handle.child.stdin.write(userEnvelope(text, messageId));
  broadcast("run_input_ack", { id, messageId, at: Date.now() });
  return { messageId };
}

// ── Interactive permission gate: pending-decision store ─────────────────
//
// Each armed run holds a Map of open permission requests on its handle. The
// gate hook (scripts/permission-gate.js) opens one per tool call and
// short-polls for a decision; the dashboard UI posts allow/deny. Everything
// here is ephemeral and per-run - no DB, matching how live run state is kept.

/** Serialisable view of one request (never leaks the resolve internals). */
function publicPermission(entry) {
  return {
    requestId: entry.requestId,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    status: entry.status, // "pending" | "resolved"
    decision: entry.decision, // "allow" | "deny" | null
    reason: entry.reason || null,
    openedAt: entry.openedAt,
    resolvedAt: entry.resolvedAt || null,
  };
}

/** Deny + resolve an entry in place (used on timeout, kill, and expiry). */
function resolveEntry(entry, decision, reason) {
  entry.status = "resolved";
  entry.decision = decision;
  entry.reason = reason;
  entry.resolvedAt = Date.now();
}

/**
 * Lazily expire a pending entry older than the TTL. The gate hook denies on
 * its own 10-minute timeout first; this only rescues entries whose hook died
 * without ever resolving them, so the UI never shows a forever-pending row.
 */
function expireIfStale(entry) {
  if (entry.status === "pending" && Date.now() - entry.openedAt > PERMISSION_REQUEST_TTL_MS) {
    resolveEntry(entry, "deny", "expired without a decision");
  }
}

/**
 * Open (or return the existing) permission request for a run+tool call. Keyed
 * by requestId (the hook passes the tool_use_id) so a retried hook POST is
 * idempotent rather than opening duplicates. Broadcasts `permission_request`
 * only on first open. Throws ENOTFOUND for an unknown/dead run and
 * ENOTINTERACTIVE for a run that never opted in (defence in depth - the gate
 * only fires for armed runs, but never trust that alone).
 */
function openPermissionRequest(runId, { requestId, toolName, toolInput }) {
  const handle = handles.get(runId);
  if (!handle) throw makeErr("ENOTFOUND", "run not found");
  if (handle.permissionUx !== "interactive") {
    throw makeErr("ENOTINTERACTIVE", "run did not opt into interactive permissions");
  }
  if (!requestId || typeof requestId !== "string") {
    throw makeErr("EBADREQUEST", "requestId is required");
  }
  const existing = handle.permissions.get(requestId);
  if (existing) {
    expireIfStale(existing);
    return publicPermission(existing);
  }
  const entry = {
    requestId,
    toolName: typeof toolName === "string" ? toolName : "unknown",
    toolInput: toolInput ?? null,
    status: "pending",
    decision: null,
    reason: null,
    openedAt: Date.now(),
    resolvedAt: null,
  };
  handle.permissions.set(requestId, entry);
  broadcast("permission_request", { id: runId, request: publicPermission(entry) });
  // Loud by default (Phase A requirement): a pending request must reach the
  // user even when the dashboard tab isn't open. Fire-and-forget - push
  // delivery is a side benefit, never a blocker for the gate itself.
  notifyPermissionRequest(runId, entry);
  return publicPermission(entry);
}

/** Current state of one request, or null if unknown. Expires stale entries. */
function getPermissionRequest(runId, requestId) {
  const handle = handles.get(runId);
  if (!handle) return null;
  const entry = handle.permissions.get(requestId);
  if (!entry) return null;
  expireIfStale(entry);
  return publicPermission(entry);
}

/** Every open+resolved request for a run (UI attach / degraded-WS fallback). */
function listPermissionRequests(runId) {
  const handle = handles.get(runId);
  if (!handle) return [];
  const out = [];
  for (const entry of handle.permissions.values()) {
    expireIfStale(entry);
    out.push(publicPermission(entry));
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Record the dashboard user's allow/deny for a request. Idempotent: resolving
 * an already-resolved request is a no-op that returns the settled state.
 * Broadcasts `permission_resolved`. Returns the public entry, or null if the
 * run/request is unknown.
 */
function resolvePermissionRequest(runId, requestId, { decision, reason }) {
  const handle = handles.get(runId);
  if (!handle) return null;
  const entry = handle.permissions.get(requestId);
  if (!entry) return null;
  if (decision !== "allow" && decision !== "deny") {
    throw makeErr("EBADDECISION", 'decision must be "allow" or "deny"');
  }
  if (entry.status !== "resolved") {
    resolveEntry(entry, decision, typeof reason === "string" && reason ? reason : null);
    broadcast("permission_resolved", { id: runId, request: publicPermission(entry) });
  }
  return publicPermission(entry);
}

/** Deny every still-pending request for a run - called when it's torn down so
 *  a gate hook still polling exits promptly instead of waiting out its cap. */
function denyAllPending(handle, reason) {
  if (!handle || !handle.permissions) return;
  for (const entry of handle.permissions.values()) {
    if (entry.status === "pending") {
      resolveEntry(entry, "deny", reason);
      broadcast("permission_resolved", { id: handle.id, request: publicPermission(entry) });
    }
  }
}

function killRun(id) {
  const handle = handles.get(id);
  if (!handle) return false;
  if (handle.status === "completed" || handle.status === "error" || handle.status === "killed") {
    return true;
  }
  // Release any gate hook still polling before we tear the process down.
  denyAllPending(handle, "run was stopped");
  if (handle.child && !handle.child.killed) {
    try {
      handle.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      const h = handles.get(id);
      if (h && h.child && !h.child.killed) {
        try {
          h.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 5000).unref?.();
  }
  handle.status = "killed";
  handle.endedAt = Date.now();
  broadcast("run_status", { id, status: "killed", at: handle.endedAt });
  patchRun({ id, status: "killed", endedAt: handle.endedAt });
  scheduleReap(id);
  return true;
}

function publicHandle(handle, opts = {}) {
  if (!handle) return null;
  const out = {
    id: handle.id,
    pid: handle.pid,
    provider: handle.provider || "claude",
    mode: handle.mode,
    cwd: handle.cwd,
    model: handle.model,
    permissionMode: handle.permissionMode,
    permissionUx: handle.permissionUx || "auto",
    effort: handle.effort || null,
    projectId: handle.projectId || null,
    prompt: handle.prompt,
    argv: handle.argv,
    resumeSessionId: handle.resumeSessionId || null,
    status: handle.status,
    startedAt: handle.startedAt,
    endedAt: handle.endedAt,
    exitCode: handle.exitCode,
    signal: handle.signal,
    error: handle.error,
    sessionId: handle.sessionId,
    envelopeCount: handle.envelopeCount,
    // Live-attaching UI can rebuild the pending-permission panel without
    // waiting for the next WS broadcast (degrades safely per frontend rules).
    pendingPermissions: handle.permissions
      ? Array.from(handle.permissions.values())
          .filter((e) => e.status === "pending")
          .map(publicPermission)
      : [],
    stdoutTail: handle.stdoutBuffer,
    stderrTail: handle.stderrBuffer,
  };
  if (opts.includeEnvelopes) {
    out.envelopes = handle.envelopes.slice();
  }
  return out;
}

function getRun(id, opts = {}) {
  return publicHandle(handles.get(id), opts);
}

function listRuns() {
  return Array.from(handles.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(publicHandle);
}

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Test seam: inject a fake child (e.g. PassThrough streams) without invoking
// the real `claude` binary. Returns the handle.
function __injectChildForTest({
  child,
  mode = "conversation",
  prompt = "test",
  permissionUx = "auto",
}) {
  const id = randomUUID();
  const handle = {
    id,
    pid: 0,
    provider: "claude",
    mode,
    cwd: process.cwd(),
    model: null,
    permissionMode: "acceptEdits",
    permissionUx,
    effort: null,
    prompt,
    argv: ["-p", prompt],
    resumeSessionId: null,
    status: "spawning",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    sessionId: null,
    envelopeCount: 0,
    envelopes: [],
    permissions: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    child,
  };
  handles.set(id, handle);
  attachStreamHandlers(handle);
  return handle;
}

function __reset() {
  for (const t of reapers.values()) clearTimeout(t);
  reapers.clear();
  handles.clear();
}

module.exports = {
  spawnRun,
  sendInput,
  killRun,
  getRun,
  listRuns,
  liveCount,
  getMaxConcurrent,
  openPermissionRequest,
  getPermissionRequest,
  listPermissionRequests,
  resolvePermissionRequest,
  onRunStatus,
  __injectChildForTest,
  __reset,
};
