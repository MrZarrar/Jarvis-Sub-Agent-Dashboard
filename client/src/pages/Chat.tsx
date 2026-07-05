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
  Paperclip,
  FileText,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { Select } from "../components/Select";
import type { SelectOption } from "../components/Select";
import { MarkdownContent } from "../components/conversation/MarkdownContent";
import type {
  Chat as ChatType,
  ChatAttachment,
  ChatMessage,
  ChatProviderStatus,
  LinkPreview,
} from "../lib/types";
import { timeAgo } from "../lib/format";

// First http(s) URL in a message, for the Phase-Q2 preview card. Markdown
// links and bare URLs both match; trailing punctuation is trimmed.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/;
function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

// Module-level so cards don't refetch on every re-render / chat switch.
// null = fetch failed (don't retry this session).
const linkPreviewCache = new Map<string, LinkPreview | null>();

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

  // Attachments (Phase Q1): uploaded before send, threaded into the message.
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    setError(null);
    setUploading(true);
    try {
      for (const file of files) {
        const res = await api.chat.upload(file);
        setPending((prev) => [...prev, res.attachment]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles]
  );

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
    if ((!text && pending.length === 0) || streaming || !provider) return;
    setError(null);
    let chatId: string;
    try {
      chatId = await ensureChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create chat");
      return;
    }
    const attachments = pending;
    setInput("");
    setPending([]);
    setStreaming(true);
    setStreamingText("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.chat.stream(
        chatId,
        {
          text,
          provider,
          model: model || undefined,
          ...(attachments.length ? { attachments } : {}),
        },
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
  }, [input, pending, streaming, provider, model, activeChatId]);

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
        <div
          className="border-t border-border p-3 bg-surface-2/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          {/* Pending attachment chips (Phase Q1) */}
          {pending.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {pending.map((a) => (
                <span
                  key={a.file}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-2 py-1 text-xs text-gray-300"
                >
                  {a.kind === "image" ? (
                    <img
                      src={`/api/chat/uploads/${a.file}`}
                      alt={a.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-gray-500" />
                  )}
                  <span className="max-w-40 truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setPending((prev) => prev.filter((p) => p.file !== a.file))}
                    className="text-gray-500 hover:text-gray-200"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {pending.some((a) => a.kind === "image") &&
                activeProvider &&
                !activeProvider.capabilities.vision && (
                  <span className="text-[11px] text-amber-300">
                    {activeProvider.label} can't see images — switch to Gemini for vision.
                  </span>
                )}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.txt,.log,.json,.csv,.yml,.yaml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.sh,.sql"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!providerReady || uploading}
              title="Attach an image or file (or paste / drag-drop)"
              className="btn-secondary p-2 disabled:opacity-40"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
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
                  disabled={(!input.trim() && pending.length === 0) || !providerReady}
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
        {/* URL preview card (Phase Q2): first link in the message */}
        {!message.image_path && firstUrl(message.content) && (
          <LinkCard url={firstUrl(message.content)!} />
        )}
        {/* Uploaded attachments (Phase Q1) */}
        {(message.attachments?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments!.map((a) =>
              a.kind === "image" ? (
                <a
                  key={a.file}
                  href={`/api/chat/uploads/${a.file}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src={`/api/chat/uploads/${a.file}`}
                    alt={a.name}
                    className="max-h-48 rounded-md"
                  />
                </a>
              ) : (
                <a
                  key={a.file}
                  href={`/api/chat/uploads/${a.file}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                >
                  <FileText className="w-3.5 h-3.5 text-gray-500" />
                  <span className="max-w-48 truncate">{a.name}</span>
                </a>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** OpenGraph card for the first link in a message (Phase Q2). Renders nothing
 *  until the SSRF-guarded server fetch succeeds; failures stay blank. */
function LinkCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(() =>
    linkPreviewCache.has(url) ? linkPreviewCache.get(url) : undefined
  );

  useEffect(() => {
    if (linkPreviewCache.has(url)) {
      setPreview(linkPreviewCache.get(url));
      return;
    }
    let cancelled = false;
    api.chat
      .linkPreview(url)
      .then((r) => {
        linkPreviewCache.set(url, r.preview);
        if (!cancelled) setPreview(r.preview);
      })
      .catch(() => {
        linkPreviewCache.set(url, null);
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!preview || (!preview.title && !preview.description && !preview.image)) return null;
  let host = "";
  try {
    host = new URL(preview.url).hostname;
  } catch {
    /* leave blank */
  }
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex max-w-md gap-2.5 rounded-md border border-border bg-surface-2/60 p-2 no-underline hover:bg-surface-2 transition-colors"
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          className="h-14 w-14 shrink-0 rounded object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-gray-200">
          {preview.title || host}
        </span>
        {preview.description && (
          <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 line-clamp-2">
            {preview.description}
          </span>
        )}
        <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-gray-600">
          {preview.siteName || host}
        </span>
      </span>
    </a>
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
