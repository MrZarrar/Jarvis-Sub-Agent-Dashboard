/**
 * @file providers/claude.js
 * @description Claude chat adapter for the multi-provider harness (Phase E,
 * §3.1). Unlike the agentic Run feature (run-spawner.js), the Chat page wants a
 * plain streaming completion, so this spawns a short-lived headless
 * `claude -p … --output-format stream-json --verbose --include-partial-messages`
 * and surfaces only the assistant text. It captures the `session_id` from the
 * init envelope and accepts `resumeSessionId` so multi-turn chat continues one
 * Claude Code session (`--resume`) instead of re-sending the whole transcript.
 *
 * This is the SAME `claude` binary and auth as everywhere else (no keys) - it
 * inherits the user's existing OAuth from $HOME.
 *
 * @author Jarvis (Phase E)
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const { createLineParser } = require("../stream-json-parser");
const { getProviderConfig } = require("./config");
const { callWithToolsViaChat } = require("./cli-tools");
// Phase P: organic usage capture. Both the Chat page and the brain router's
// complex-tier `claude -p` calls run through this adapter, so tapping the
// stream here covers both at zero extra token cost.
const usageCache = require("../usage-cache");

function cfg() {
  return getProviderConfig("claude");
}

function isConfigured() {
  // `claude` is a local binary; treat the provider as available whenever it's
  // enabled. (The Run page's /binary probe already tells the user if it's on
  // PATH; a spawn failure here surfaces as an honest error mid-stream.)
  return Boolean(cfg().enabled);
}

function listModels() {
  const c = cfg();
  const models = Array.isArray(c.chatModels) ? c.chatModels : [];
  return models.map((id) => ({ id, label: id }));
}

/** When starting fresh (no session to resume), fold the whole transcript into
 *  one prompt so Claude sees the prior turns. Roles are labeled plainly. */
function transcriptPrompt(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") parts.push(`System: ${m.content}`);
    else if (m.role === "assistant") parts.push(`Assistant: ${m.content}`);
    else parts.push(`User: ${m.content}`);
  }
  return parts.join("\n\n");
}

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user" && typeof messages[i].content === "string") {
      return messages[i].content;
    }
  }
  return "";
}

/**
 * Async generator yielding { text } deltas and one { meta: { sessionId } } once
 * known. Bridges the spawned process's event-driven stdout into an async
 * iterator via a small pull-queue.
 */
async function* chatStream(messages, opts = {}) {
  const c = cfg();
  const model = opts.model || c.defaultModel || null;
  const resume =
    typeof opts.resumeSessionId === "string" && /^[A-Za-z0-9-]{8,}$/.test(opts.resumeSessionId)
      ? opts.resumeSessionId
      : null;

  const prompt = resume ? lastUserText(messages) : transcriptPrompt(messages);
  const argv = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (model) argv.push("--model", model);
  if (resume) argv.push("--resume", resume);
  if (opts.disableNativeTools) argv.push("--tools", "");

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;

  // Mini Jarvis supplies its own complete prompt and action gate. A neutral cwd
  // prevents an unrelated repo's hooks/instructions from contaminating JSON.
  const child = spawn("claude", argv, {
    env,
    cwd: opts.cwd || os.homedir(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pull-queue bridging EventEmitter → async iterator.
  const queue = [];
  let resolveNext = null;
  let done = false;
  let failure = null;
  const emit = (item) => {
    if (resolveNext) {
      resolveNext(item);
      resolveNext = null;
    } else {
      queue.push(item);
    }
  };

  let sawText = false;
  let finalText = "";
  const parser = createLineParser(
    (env2) => {
      // Phase P: organic rate-limit capture (no-op for non-rate_limit_event).
      usageCache.tapEnvelope(env2, "organic");
      if (
        env2?.type === "system" &&
        env2.subtype === "init" &&
        typeof env2.session_id === "string"
      ) {
        emit({ meta: { sessionId: env2.session_id } });
      }
      // Real-time text deltas from --include-partial-messages.
      if (env2?.type === "stream_event") {
        const ev = env2.event;
        if (
          ev?.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          ev.delta.text
        ) {
          sawText = true;
          emit({ text: ev.delta.text });
        }
        return;
      }
      // Fallback: capture the final assistant text if no deltas were seen.
      if (env2?.type === "assistant" && Array.isArray(env2.message?.content)) {
        finalText = env2.message.content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
      }
    },
    () => {}
  );

  let stderr = "";
  child.stdout.on("data", (chunk) => parser.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });
  child.on("error", (err) => {
    failure = new Error(`claude spawn failed: ${err.message}`);
    done = true;
    emit(null);
  });
  child.on("exit", (code) => {
    parser.flush();
    if (code !== 0 && !sawText && !finalText) {
      failure = new Error(`claude exited ${code}: ${stderr.slice(-300) || "no output"}`);
    } else if (!sawText && finalText) {
      emit({ text: finalText });
    }
    done = true;
    emit(null);
  });

  if (opts.signal) {
    opts.signal.addEventListener(
      "abort",
      () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      },
      { once: true }
    );
  }

  try {
    while (true) {
      let item;
      if (queue.length) item = queue.shift();
      else item = await new Promise((r) => (resolveNext = r));
      if (item === null) break;
      yield item;
    }
    if (failure) throw failure;
  } finally {
    if (!done) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}

function callWithTools(messages, tools = [], opts = {}) {
  return callWithToolsViaChat(chatStream, messages, tools, opts);
}

/**
 * Run ONE headless Claude Code agent task to completion and return its final
 * text (non-streaming). Unlike chatStream (a plain chat completion), this spawns
 * a FULL agent: default tool set (WebSearch/WebFetch/Bash/Read/Write/…) plus any
 * installed skills (e.g. agent-reach). It is how a text-only brain tier (Gemini)
 * gets the internet and multi-step agency - it delegates the task to Claude.
 *
 * ponytail: `bypassPermissions` so the agent can actually use its tools with no
 * prompt (there's no human at a headless spawn to approve WebFetch/Bash). This is
 * the "full access" the user opted into; it is reached ONLY through the gated
 * legacy direct-agent callers. Jarvis mission delegation no longer uses this path.
 * Same local `claude` binary + OAuth as everywhere else - no API key, free.
 */
function runAgentTask(task, opts = {}) {
  const c = cfg();
  const model = opts.model || c.defaultModel || null;
  const prompt = opts.hint ? `${String(task || "")}\n\n(${opts.hint})` : String(task || "");
  const argv = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode || "bypassPermissions",
  ];
  if (model) argv.push("--model", model);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;

  // Run in a NEUTRAL cwd (home), not the dashboard's own dir - otherwise the
  // delegated agent inherits this project's `.claude/` hooks (e.g. a Stop gate)
  // and gets hijacked instead of doing the task. Home still resolves the user's
  // global `~/.claude/skills` (agent-reach lives there), so no capability lost.
  const cwd = opts.cwd || os.homedir();

  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let finalText = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    const parser = createLineParser(
      (env2) => {
        usageCache.tapEnvelope(env2, "organic");
        // The terminal `result` envelope carries the whole final answer; prefer it.
        if (env2?.type === "result" && typeof env2.result === "string") {
          finalText = env2.result;
        } else if (env2?.type === "assistant" && Array.isArray(env2.message?.content)) {
          const t = env2.message.content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
          if (t) finalText = t;
        }
      },
      () => {}
    );

    child.stdout.on("data", (chunk) => parser.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => finish(reject, new Error(`claude spawn failed: ${err.message}`)));
    child.on("exit", (code) => {
      parser.flush();
      if (!finalText && code !== 0) {
        return finish(
          reject,
          new Error(`claude exited ${code}: ${stderr.slice(-300) || "no output"}`)
        );
      }
      finish(resolve, finalText.trim());
    });

    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish(reject, new Error("claude agent task timed out"));
    }, opts.timeoutMs || 180_000);
  });
}

module.exports = {
  id: "claude",
  label: "Claude",
  capabilities: { chat: true, image: false, tools: true, promptTools: true },
  isConfigured,
  listModels,
  chatStream,
  callWithTools,
  runAgentTask,
};
