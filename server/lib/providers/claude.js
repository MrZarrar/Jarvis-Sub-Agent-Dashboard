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
const { createLineParser } = require("../stream-json-parser");
const { getProviderConfig } = require("./config");
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

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;

  const child = spawn("claude", argv, { env, stdio: ["ignore", "pipe", "pipe"] });

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

module.exports = {
  id: "claude",
  label: "Claude",
  capabilities: { chat: true, image: false },
  isConfigured,
  listModels,
  chatStream,
};
