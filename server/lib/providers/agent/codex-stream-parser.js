/**
 * Normalize Codex CLI JSONL and app-server JSON-RPC notifications into the
 * dashboard's existing Claude-shaped envelope vocabulary.
 */

const { createLineParser } = require("../../stream-json-parser");

function assistantText(text, id) {
  return {
    type: "assistant",
    message: { id: id || undefined, role: "assistant", content: [{ type: "text", text }] },
  };
}

function toolUse(item) {
  const name =
    item.type === "commandExecution"
      ? "Bash"
      : item.type === "fileChange"
        ? "Edit"
        : item.type === "webSearch"
          ? "WebSearch"
          : item.type === "mcpToolCall"
            ? `${item.server || "mcp"}.${item.tool || "tool"}`
            : item.type || "tool";
  const input =
    item.type === "commandExecution"
      ? { command: item.command, cwd: item.cwd }
      : item.arguments || item.changes || { query: item.query };
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: item.id || `codex-${Date.now()}`, name, input }],
    },
  };
}

function toolResult(item) {
  const content =
    item.aggregatedOutput ??
    item.result ??
    item.error ??
    item.changes ??
    item.status ??
    "completed";
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: item.id || "",
          content: typeof content === "string" ? content : JSON.stringify(content),
          is_error: item.status === "failed" || item.status === "error",
        },
      ],
    },
  };
}

function normalizeItem(item, completed = true) {
  if (!item || typeof item !== "object") return [];
  const typeAliases = {
    agent_message: "agentMessage",
    user_message: "userMessage",
    command_execution: "commandExecution",
    file_change: "fileChange",
    mcp_tool_call: "mcpToolCall",
    dynamic_tool_call: "dynamicToolCall",
    web_search: "webSearch",
    image_view: "imageView",
    collab_agent_tool_call: "collabAgentToolCall",
  };
  if (typeAliases[item.type]) item = { ...item, type: typeAliases[item.type] };
  if (item.type === "agentMessage") return item.text ? [assistantText(item.text, item.id)] : [];
  if (item.type === "reasoning") return [];
  if (item.type === "userMessage") return [];
  const supported = new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageView",
    "collabAgentToolCall",
  ]);
  if (!supported.has(item.type)) return [];
  return completed ? [toolUse(item), toolResult(item)] : [];
}

function normalizeExec(obj) {
  if (!obj || typeof obj !== "object") return [];
  const type = obj.type || obj.event;
  if (type === "thread.started") {
    return [{ type: "system", subtype: "init", session_id: obj.thread_id || obj.threadId || null }];
  }
  if (type === "item.completed") return normalizeItem(obj.item, true);
  if (type === "turn.completed") {
    return [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: null,
        usage: obj.usage || null,
      },
    ];
  }
  if (type === "turn.failed" || type === "error") {
    return [
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: obj.message || obj.error?.message || "Codex run failed",
      },
    ];
  }
  return [];
}

function createCodexExecParser(onObject, onError) {
  return createLineParser((obj) => {
    for (const env of normalizeExec(obj)) onObject(env);
  }, onError);
}

function streamEvent(itemId, event) {
  return {
    type: "stream_event",
    event: { ...event, message: { ...(event.message || {}), id: itemId } },
  };
}

function createCodexAppServerParser(onObject, onError, handle) {
  const state = handle.providerState;
  return createLineParser((obj) => {
    if (!obj || typeof obj !== "object") return;

    if (Object.prototype.hasOwnProperty.call(obj, "id") && (obj.result || obj.error)) {
      const pending = state.pending.get(String(obj.id));
      state.pending.delete(String(obj.id));
      if (obj.error) {
        onError(
          new Error(obj.error.message || "Codex app-server request failed"),
          JSON.stringify(obj)
        );
        return;
      }
      if (pending === "initialize") {
        state.notify("initialized", {});
        state.request(
          handle.resumeSessionId ? "thread/resume" : "thread/start",
          {
            ...(handle.resumeSessionId ? { threadId: handle.resumeSessionId } : {}),
            cwd: handle.cwd,
            model: handle.model || null,
            approvalPolicy: "never",
            sandbox: state.sandbox,
          },
          "thread"
        );
      } else if (pending === "thread") {
        const thread = obj.result.thread || {};
        state.threadId = thread.id || handle.resumeSessionId || null;
        if (state.threadId) {
          onObject({ type: "system", subtype: "init", session_id: state.threadId });
          if (handle.prompt && handle.prompt.trim()) state.startTurn(handle.prompt);
        }
      } else if (pending && pending.kind === "turn") {
        state.activeTurnId = obj.result?.turn?.id || state.activeTurnId;
      }
      return;
    }

    const method = obj.method;
    const params = obj.params || {};
    if (method === "thread/started") {
      state.threadId = params.thread?.id || params.threadId || state.threadId;
      return;
    }
    if (method === "turn/started") {
      state.activeTurnId = params.turn?.id || params.turnId || state.activeTurnId;
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn || {};
      state.activeTurnId = null;
      onObject({
        type: "result",
        subtype: turn.status === "failed" ? "error" : "success",
        is_error: turn.status === "failed",
        result: turn.error?.message || null,
      });
      return;
    }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const id = params.itemId || "codex-message";
      if (!state.streamingItems.has(id)) {
        state.streamingItems.add(id);
        onObject(
          streamEvent(id, {
            type: "message_start",
            message: { id, role: "assistant", content: [], usage: {} },
          })
        );
        onObject(
          streamEvent(id, {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })
        );
      }
      onObject(
        streamEvent(id, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: params.delta },
        })
      );
      return;
    }
    if (method === "item/completed") {
      const item = params.item;
      if (item?.id) state.streamingItems.delete(item.id);
      for (const env of normalizeItem(item, true)) onObject(env);
      return;
    }
    if (method === "error") {
      onError(
        new Error(params.error?.message || params.message || "Codex app-server error"),
        JSON.stringify(obj)
      );
    }
  }, onError);
}

function createCodexParser(onObject, onError, handle) {
  return handle?.providerProtocol === "app-server"
    ? createCodexAppServerParser(onObject, onError, handle)
    : createCodexExecParser(onObject, onError);
}

module.exports = {
  createCodexParser,
  createCodexExecParser,
  createCodexAppServerParser,
  normalizeExec,
  normalizeItem,
};
