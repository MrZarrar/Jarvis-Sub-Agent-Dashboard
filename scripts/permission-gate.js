#!/usr/bin/env node

/**
 * Claude Code PreToolUse permission gate.
 *
 * A SECOND, separate PreToolUse hook (installed alongside the fire-and-forget
 * observability hook `hook-handler.js`, never replacing it). Its job is to let
 * the dashboard interactively approve or deny each tool call for runs the
 * dashboard itself spawned with `permissionUx: "interactive"`.
 *
 * SAFETY - no-op for every other session. This hook fires for *every*
 * PreToolUse across *every* Claude Code session once installed globally
 * (plain terminal use, non-interactive dashboard runs, everything). It must
 * therefore be an instant, side-effect-free pass-through unless explicitly
 * armed. Arming is signalled by one env var, `JARVIS_INTERACTIVE_PERMISSIONS`,
 * which the dashboard's run-spawner injects ONLY into children it launched in
 * interactive mode. If that var is absent we exit 0 with NO stdout in well
 * under a millisecond - Claude Code treats "exit 0, no decision" as "hook has
 * no opinion", so the tool call proceeds exactly as if this hook didn't exist.
 *
 * When armed, we:
 *   1. read the PreToolUse hook JSON on stdin (tool_name, tool_input,
 *      tool_use_id, …),
 *   2. POST it to the spawning dashboard to open a pending permission request,
 *   3. short-poll that dashboard until a human clicks Allow/Deny (or a hard
 *      10-minute timeout elapses),
 *   4. emit the decision as PreToolUse `hookSpecificOutput` and exit.
 *
 * FAIL TOWARD SAFETY (CLAUDE.md): every failure path - unreachable dashboard,
 * a run that no longer exists, a malformed request, the hard timeout - resolves
 * to **deny**, never allow. A wedged dashboard can at worst stall then block a
 * tool call; it can never silently wave one through.
 *
 * Env contract (kept in sync with server/lib/run-spawner.js):
 *   JARVIS_INTERACTIVE_PERMISSIONS = <runId>   arms the gate for that run
 *   JARVIS_DASHBOARD_PORT          = <port>    the exact dashboard to ask
 */

const http = require("http");

const RUN_ID = process.env.JARVIS_INTERACTIVE_PERMISSIONS;

// The single most important line in this file: if we weren't explicitly armed
// for a specific dashboard run, do nothing at all. Sub-millisecond, no stdout,
// no network, no stdin read. This is what keeps every normal session - and
// every non-interactive dashboard run - completely unaffected.
if (!RUN_ID) {
  process.exit(0);
}

const POLL_INTERVAL_MS = 500;
const HARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: long enough for a human, bounded enough to never wedge a run

let settled = false;

/** Emit a PreToolUse decision and exit. Guarded so we only ever emit once. */
function emit(decision, reason) {
  if (settled) return;
  settled = true;
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
  try {
    process.stdout.write(payload, () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function deny(reason) {
  emit("deny", reason);
}

// Absolute backstop: even if some await never settles, guarantee this hook
// resolves (to deny) rather than blocking the tool call forever.
setTimeout(() => deny("gate: hard timeout"), HARD_TIMEOUT_MS + 10 * 1000).unref?.();

/** Resolve the dashboard port to talk to: explicit injection wins; fall back
 *  to the discovery file, then the conventional default. Never throws. */
function resolvePort() {
  const injected = parseInt(process.env.JARVIS_DASHBOARD_PORT || "", 10);
  if (Number.isInteger(injected) && injected > 0) return injected;
  try {
    return require("../server/lib/server-info").resolveDashboardPort();
  } catch {
    return 4820;
  }
}

const PORT = resolvePort();

/** Minimal loopback JSON request. Resolves { status, json } and never rejects;
 *  network failures resolve as { status: 0 } so callers stay on one path. */
function request(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": data.length } : {}),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-JSON / empty body */
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on("error", () => resolve({ status: 0, json: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  main().catch((err) => deny(`gate: unexpected error (${err && err.message})`));
});

async function main() {
  let hook;
  try {
    hook = JSON.parse(input);
  } catch {
    return deny("gate: could not parse hook input");
  }
  const toolUseId = hook.tool_use_id;
  if (!toolUseId || typeof toolUseId !== "string") {
    return deny("gate: missing tool_use_id");
  }

  // Open the request on the spawning dashboard.
  const opened = await request("POST", `/api/run/${RUN_ID}/permission/request`, {
    toolUseId,
    toolName: hook.tool_name,
    toolInput: hook.tool_input,
  });
  if (opened.status >= 300 || opened.status === 0) {
    // Unreachable dashboard, unknown run, or a run that didn't opt in - all
    // resolve to deny (fail toward safety); we never let a tool through when
    // we can't establish the gate.
    return deny(`gate: could not open permission request (status ${opened.status})`);
  }
  const openedReq = opened.json && opened.json.request;
  if (openedReq && openedReq.status === "resolved") {
    // Raced with a decision (or a retry of an already-answered request).
    return emit(openedReq.decision === "allow" ? "allow" : "deny", openedReq.reason || "resolved");
  }

  // Short-poll until resolved or the hard timeout. Short-poll (not long-poll)
  // sidesteps Node's default 5-minute server request timeout killing a held
  // connection mid-wait.
  const deadline = Date.now() + HARD_TIMEOUT_MS;
  while (Date.now() < deadline && !settled) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await request(
      "GET",
      `/api/run/${RUN_ID}/permission/request/${encodeURIComponent(toolUseId)}`
    );
    if (poll.status === 404) {
      // The run was reaped / the request vanished - deny safe.
      return deny("gate: permission request no longer exists");
    }
    const r = poll.status < 300 && poll.json && poll.json.request;
    if (r && r.status === "resolved") {
      return emit(r.decision === "allow" ? "allow" : "deny", r.reason || "resolved");
    }
    // Any transient error (status 0/5xx) - keep polling until the deadline.
  }
  return deny("gate: timed out awaiting a decision");
}
