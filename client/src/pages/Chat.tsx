/**
 * @file Chat.tsx
 * @description Multi-provider AI chat (Phase E, §E1). A left rail of saved
 * conversations, a streaming markdown transcript, and a composer with a
 * provider/model picker. Assistant replies stream token-by-token over SSE
 * (api.chat.stream); Gemini adds an image-generation action whose output is
 * stored server-side and rendered inline. Provider secrets never touch the
 * client - the picker only sees which providers are configured.
 *
 * @author Jarvis (Phase E)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquarePlus,
  Send,
  Trash2,
  Image as ImageIcon,
  Square,
  Loader2,
  BookmarkPlus,
  BrainCircuit,
} from "lucide-react";
import { api } from "../lib/api";
import { Select } from "../components/Select";
import type { SelectOption } from "../components/Select";
import { MarkdownContent } from "../components/conversation/MarkdownContent";
import type { Chat as ChatType, ChatMessage, ChatProviderStatus } from "../lib/types";
import { timeAgo } from "../lib/format";

export function Chat() {
  const [providers, setProviders] = useState<ChatProviderStatus[]>([]);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [chats, setChats] = useState<ChatType[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === provider) || null,
    [providers, provider]
  );

  // ── Initial load: providers + chat list ──────────────────────────────────
  useEffect(() => {
    api.chat
      .providers()
      .then((res) => {
        setProviders(res.providers);
        const firstReady = res.providers.find((p) => p.configured && !p.disabled);
        const pick = firstReady || res.providers.find((p) => !p.disabled) || res.providers[0];
        if (pick) {
          setProvider(pick.id);
          setModel(pick.defaultModel || pick.models[0]?.id || "");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load providers"));
    api.chat
      .listChats()
      .then((res) => setChats(res.items))
      .catch(() => {});
  }, []);

  // Keep the model valid when the provider changes.
  useEffect(() => {
    if (!activeProvider) return;
    const has = activeProvider.models.some((m) => m.id === model);
    if (!has) setModel(activeProvider.defaultModel || activeProvider.models[0]?.id || "");
  }, [activeProvider, model]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const selectChat = useCallback(async (id: string) => {
    setActiveChatId(id);
    setError(null);
    try {
      const res = await api.chat.getChat(id);
      setMessages(res.messages);
      if (res.chat.provider) setProvider(res.chat.provider);
      if (res.chat.model) setModel(res.chat.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chat");
    }
  }, []);

  const newChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setError(null);
  }, []);

  async function ensureChat(): Promise<string> {
    if (activeChatId) return activeChatId;
    const res = await api.chat.createChat({ provider, model });
    setChats((prev) => [res.chat, ...prev]);
    setActiveChatId(res.chat.id);
    return res.chat.id;
  }

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !provider) return;
    setError(null);
    let chatId: string;
    try {
      chatId = await ensureChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create chat");
      return;
    }
    setInput("");
    setStreaming(true);
    setStreamingText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.chat.stream(
        chatId,
        { text, provider, model: model || undefined },
        {
          onUser: (m) => setMessages((prev) => [...prev, m]),
          onDelta: (delta) => setStreamingText((prev) => prev + delta),
          onDone: (m) => {
            setMessages((prev) => [...prev, m]);
            setStreamingText("");
            setStreaming(false);
            refreshChats();
          },
          onError: (message) => {
            setError(message);
            setStreamingText((partial) => {
              if (partial) {
                setMessages((prev) => [
                  ...prev,
                  makeLocalAssistant(chatId, provider, model, partial),
                ]);
              }
              return "";
            });
            setStreaming(false);
          },
        },
        controller.signal
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Stream failed");
      setStreaming(false);
      setStreamingText("");
    } finally {
      abortRef.current = null;
    }
  }, [input, streaming, provider, model, activeChatId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingText((partial) => {
      if (partial && activeChatId) {
        setMessages((prev) => [
          ...prev,
          makeLocalAssistant(activeChatId, provider, model, partial),
        ]);
      }
      return "";
    });
  }, [activeChatId, provider, model]);

  const genImage = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setError(null);
    let chatId: string;
    try {
      chatId = await ensureChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create chat");
      return;
    }
    setInput("");
    setStreaming(true);
    try {
      await api.chat.generateImage(chatId, prompt, model || undefined);
      const res = await api.chat.getChat(chatId);
      setMessages(res.messages);
      refreshChats();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image generation failed");
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, model, activeChatId]);

  function refreshChats() {
    api.chat
      .listChats()
      .then((res) => setChats(res.items))
      .catch(() => {});
  }

  // ── Save-to-vault (Phase S): one message, or a brain-condensed summary ────
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savingSummary, setSavingSummary] = useState(false);

  const saveMessageToVault = useCallback(
    async (messageId: string) => {
      if (!activeChatId) return;
      try {
        await api.vault.saveChat({ chatId: activeChatId, mode: "message", messageId });
        setSavedIds((prev) => new Set(prev).add(messageId));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save to vault");
      }
    },
    [activeChatId]
  );

  const saveSummaryToVault = useCallback(async () => {
    if (!activeChatId || savingSummary) return;
    setSavingSummary(true);
    setError(null);
    try {
      await api.vault.saveChat({ chatId: activeChatId, mode: "summary" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not summarize to vault");
    } finally {
      setSavingSummary(false);
    }
  }, [activeChatId, savingSummary]);

  const deleteChat = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await api.chat.deleteChat(id);
        setChats((prev) => prev.filter((c) => c.id !== id));
        if (activeChatId === id) newChat();
      } catch {
        /* ignore */
      }
    },
    [activeChatId, newChat]
  );

  const providerOptions: SelectOption<string>[] = providers.map((p) => ({
    value: p.id,
    label: p.disabled
      ? `${p.label} (unavailable)`
      : p.configured
        ? p.label
        : `${p.label} (not configured)`,
    hint: p.note || (p.configured ? undefined : "Set it up in Settings → Providers"),
  }));
  const modelOptions: SelectOption<string>[] = (activeProvider?.models || []).map((m) => ({
    value: m.id,
    label: m.label,
  }));
  const canImage = Boolean(activeProvider?.capabilities.image && activeProvider?.configured);
  const providerReady = Boolean(
    activeProvider && activeProvider.configured && !activeProvider.disabled
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 h-[calc(100vh-4rem)] flex gap-4">
      {/* Chat list rail */}
      <aside className="hidden md:flex w-64 flex-col card p-3 shrink-0">
        <button
          type="button"
          onClick={newChat}
          className="btn-secondary w-full justify-center gap-2 mb-3"
        >
          <MessageSquarePlus className="w-4 h-4" /> New chat
        </button>
        <div className="flex-1 overflow-y-auto space-y-1">
          {chats.length === 0 && (
            <p className="text-xs text-gray-500 px-2 py-4 text-center">No conversations yet.</p>
          )}
          {chats.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => selectChat(c.id)}
              className={`group w-full text-left px-2.5 py-2 rounded-md text-sm flex items-center justify-between gap-2 transition-colors ${
                activeChatId === c.id
                  ? "bg-accent/15 text-accent"
                  : "text-gray-300 hover:bg-surface-3/50"
              }`}
            >
              <span className="truncate">{c.title || "Untitled"}</span>
              <Trash2
                className="w-3.5 h-3.5 opacity-0 group-hover:opacity-70 hover:!opacity-100 text-gray-400 shrink-0"
                onClick={(e) => deleteChat(c.id, e)}
              />
            </button>
          ))}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 card p-0 overflow-hidden">
        {/* Header: provider + model pickers */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border bg-surface-2/40">
          <div className="w-44">
            <Select value={provider} onChange={setProvider} options={providerOptions} />
          </div>
          <div className="w-56">
            <Select
              value={model}
              onChange={setModel}
              options={
                modelOptions.length
                  ? modelOptions
                  : [{ value: "", label: activeProvider ? "No models available" : "-" }]
              }
              disabled={modelOptions.length === 0}
            />
          </div>
          {activeChatId && messages.length > 0 && (
            <button
              type="button"
              onClick={saveSummaryToVault}
              disabled={savingSummary}
              title="Summarize this conversation into the knowledge vault"
              className="btn-secondary gap-1.5 ml-auto text-xs disabled:opacity-50"
            >
              {savingSummary ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <BrainCircuit className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">Vault</span>
            </button>
          )}
          <button
            type="button"
            onClick={newChat}
            className={`md:hidden btn-secondary gap-1.5 text-xs ${
              activeChatId && messages.length > 0 ? "" : "ml-auto"
            }`}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" /> New
          </button>
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !streamingText && (
            <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 gap-2">
              <MessageSquarePlus className="w-8 h-8 text-gray-600" />
              <p className="text-sm">
                {providerReady
                  ? "Start a conversation below."
                  : "No provider configured yet - add a Gemini key or Ollama host in Settings → Providers."}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              saved={savedIds.has(m.id)}
              onSaveToVault={
                m.role === "assistant" && !m.id.startsWith("local-")
                  ? () => saveMessageToVault(m.id)
                  : undefined
              }
            />
          ))}
          {streamingText && (
            <div className="flex flex-col gap-1 items-start">
              <span className="text-[11px] uppercase tracking-wider text-accent/80">Assistant</span>
              <div className="max-w-[85%] rounded-lg bg-surface-3/40 border border-border px-3 py-2">
                <MarkdownContent text={streamingText} />
              </div>
            </div>
          )}
          {streaming && !streamingText && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <div className="mx-4 mb-2 text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-border p-3 bg-surface-2/40">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={
                providerReady
                  ? "Message… (Enter to send, Shift+Enter for newline)"
                  : "Configure a provider to chat"
              }
              disabled={!providerReady}
              className="flex-1 resize-none bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50"
            />
            <div className="flex flex-col gap-1.5">
              {canImage && (
                <button
                  type="button"
                  onClick={genImage}
                  disabled={!input.trim() || streaming}
                  title="Generate an image (Gemini)"
                  className="btn-secondary p-2 disabled:opacity-40"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
              )}
              {streaming ? (
                <button type="button" onClick={stop} className="btn-secondary p-2" title="Stop">
                  <Square className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!input.trim() || !providerReady}
                  className="btn-primary p-2 disabled:opacity-40"
                  title="Send"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onSaveToVault,
  saved,
}: {
  message: ChatMessage;
  onSaveToVault?: () => void;
  saved?: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <span className="text-[11px] uppercase tracking-wider text-gray-500">
        {isUser ? "You" : message.provider || "Assistant"}
        {message.model ? ` · ${message.model}` : ""}
        <span className="ml-1.5 normal-case text-gray-600">{timeAgo(message.created_at)}</span>
        {onSaveToVault && (
          <button
            type="button"
            onClick={onSaveToVault}
            disabled={saved}
            title={saved ? "Saved to vault" : "Save this reply to the knowledge vault"}
            className={`ml-1.5 align-middle ${
              saved ? "text-accent" : "text-gray-600 hover:text-gray-300"
            }`}
          >
            <BookmarkPlus className="w-3.5 h-3.5 inline" />
          </button>
        )}
      </span>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 border ${
          isUser ? "bg-accent/10 border-accent/25" : "bg-surface-3/40 border-border"
        }`}
      >
        {message.image_path ? (
          <a
            href={`/api/chat/images/${message.image_path}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src={`/api/chat/images/${message.image_path}`}
              alt="Generated"
              className="max-w-full rounded-md max-h-96"
            />
          </a>
        ) : isUser ? (
          <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <MarkdownContent text={message.content} />
        )}
      </div>
    </div>
  );
}

function makeLocalAssistant(
  chatId: string,
  provider: string,
  model: string,
  content: string
): ChatMessage {
  return {
    id: `local-${Date.now()}`,
    chat_id: chatId,
    role: "assistant",
    provider,
    model: model || null,
    content,
    image_path: null,
    created_at: new Date().toISOString(),
  };
}
