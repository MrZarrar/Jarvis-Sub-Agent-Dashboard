/**
 * @file TabbyPanel.tsx
 * @description The Mini-JARVIS (Tabby) assistant surface (Phase M2). A real
 *   conversation popup: a message transcript (rendered with MarkdownContent),
 *   an input box that talks to `POST /api/assistant/ask` through the brain
 *   router, a provider picker (Gemini/Claude/Ollama, synced with the spoken
 *   sticky preference), confirm chips for `needs_confirm` actions, and a
 *   typed-confirm input for `typed`-risk actions. Client-side actions
 *   (`set_hud_mode`/`navigate`/`open_panel`) are executed in the browser via the
 *   `onClientAction` callback - so "enable ultron" flips the HUD in-place and
 *   confirms in one line, instead of deep-linking to /run.
 *
 *   Status quick-answers ("what's running", "any errors") are answered instantly
 *   and offline from the cached WS status via `matchIntent`; everything else goes
 *   to the server (which itself has a deterministic prelude + agentic providers).
 *   A per-message "Run as agent" affordance replaces the old auto-deep-link: it
 *   spawns a real run via the gated `spawn_run` action and links to it.
 * @author Jarvis (Phase M2)
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Play,
  Activity,
  LayoutList,
  Bell,
  BellOff,
  Trash2,
  X,
  Send,
  AlertTriangle,
  Hourglass,
  Radio,
  Orbit,
  Moon,
  Sun,
  Maximize2,
  Minimize2,
  Check,
  ShieldAlert,
  Bot,
  Eraser,
  type LucideIcon,
} from "lucide-react";
import { MarkdownContent } from "../conversation/MarkdownContent";
import { api, type AssistantAction, type AssistantActionResult } from "../../lib/api";
import type { ChatProviderStatus } from "../../lib/types";
import type { TabbyStatus } from "./brain";
import { matchIntent } from "./intents";
import { tabbyPrefs } from "./prefs";

/** Providers Mini-JARVIS can route to (matches server KNOWN_PROVIDERS). */
const KNOWN_PROVIDERS = new Set(["gemini", "claude", "ollama"]);
/** Actions the browser executes (dispatcher marks these side:"client"). */
const CLIENT_ACTIONS = new Set(["set_hud_mode", "navigate", "open_panel"]);

let seq = 0;
const uid = () => `m${Date.now().toString(36)}-${(seq++).toString(36)}`;

interface ActionState {
  id: string;
  name: string;
  params?: Record<string, unknown>;
  status: AssistantAction["status"];
  confirmToken?: string;
  requiresTyped?: boolean;
  busy?: boolean;
  /** Resolved one-line outcome once done/denied/errored. */
  note?: string;
  /** For a spawned run: link target. */
  runId?: string;
}

type PanelMsg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; provider?: string; actions: ActionState[] };

interface TabbyPanelProps {
  status: TabbyStatus;
  muted: boolean;
  onToggleMute: () => void;
  /** True while manually put to sleep; the button toggles it. */
  asleep: boolean;
  onToggleSleep: () => void;
  onClearAlerts: () => void;
  onNavigate: (route: string) => void;
  /** Execute a client-side action (set_hud_mode / navigate / open_panel). */
  onClientAction: (name: string, params: Record<string, unknown>) => void;
  /** Drive the avatar "thinking" mood while a request is in flight. */
  onThinking?: (v: boolean) => void;
  onClose: () => void;
  /** flyout = desktop (sized, expandable); sheet = mobile (full-width sheet). */
  layout?: "flyout" | "sheet";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Human one-liner for a completed action. */
function doneLabel(name: string, params?: Record<string, unknown>): string {
  switch (name) {
    case "set_hud_mode":
      return `HUD → ${String(params?.mode ?? "")}`.trim();
    case "navigate":
      return `Opened ${String(params?.to ?? "")}`.trim();
    case "spawn_run":
      return "Agent spawned";
    case "kill_run":
      return "Run killed";
    case "steer_run":
      return "Steered";
    case "write_note":
      return "Note saved";
    default:
      return name.replace(/_/g, " ");
  }
}

/** Conversation persisted across close/reopen and page reloads (localStorage). */
interface StoredConversation {
  conversationId: string | null;
  messages: PanelMsg[];
}
// Cap how many turns we keep around so the transcript can't grow unbounded.
const MAX_STORED_MESSAGES = 60;

function isPanelMsg(v: unknown): v is PanelMsg {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.text === "string"
  );
}

function loadStoredConversation(): StoredConversation {
  const raw = tabbyPrefs.getConversation();
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const messages = Array.isArray(r.messages) ? r.messages.filter(isPanelMsg) : [];
    const conversationId = typeof r.conversationId === "string" ? r.conversationId : null;
    return { conversationId, messages };
  }
  return { conversationId: null, messages: [] };
}

export function TabbyPanel({
  status,
  muted,
  onToggleMute,
  asleep,
  onToggleSleep,
  onClearAlerts,
  onNavigate,
  onClientAction,
  onThinking,
  onClose,
  layout = "flyout",
}: TabbyPanelProps) {
  const initialConvo = useRef<StoredConversation | null>(null);
  if (initialConvo.current === null) initialConvo.current = loadStoredConversation();
  const [messages, setMessages] = useState<PanelMsg[]>(() => initialConvo.current!.messages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<ChatProviderStatus[]>([]);
  const [provider, setProvider] = useState<string>(() => tabbyPrefs.getProvider());
  const [expanded, setExpanded] = useState<boolean>(() => tabbyPrefs.getExpanded());
  const convoId = useRef<string | null>(initialConvo.current!.conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist the transcript (+ conversation id) on every change, so closing the
  // popup - or reloading the page - never wipes it. Trimmed to the most recent
  // MAX_STORED_MESSAGES turns.
  useEffect(() => {
    const trimmed =
      messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages;
    tabbyPrefs.setConversation({ conversationId: convoId.current, messages: trimmed });
  }, [messages]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    convoId.current = null;
    tabbyPrefs.clearConversation();
  }, []);

  const sheet = layout === "sheet";
  const big = sheet || expanded;

  // Provider list (only the ones Mini-JARVIS routes to, and only if usable).
  useEffect(() => {
    let cancelled = false;
    api.chat
      .providers()
      .then((r) => {
        if (cancelled) return;
        const known = r.providers.filter(
          (p) => KNOWN_PROVIDERS.has(p.id) && p.configured && p.enabled && !p.disabled
        );
        setProviders(known);
        // Default the picker to gemini (or the first usable) if nothing stuck.
        setProvider((cur) => {
          if (cur && known.some((p) => p.id === cur)) return cur;
          const pick = known.find((p) => p.id === "gemini")?.id || known[0]?.id || "";
          return pick;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Autoscroll the transcript on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const pickProvider = useCallback((id: string) => {
    setProvider(id);
    tabbyPrefs.setProvider(id);
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => {
      tabbyPrefs.setExpanded(!v);
      return !v;
    });
  }, []);

  /** Patch one action nested inside a message. */
  const patchAction = useCallback((msgId: string, actId: string, patch: Partial<ActionState>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.role === "assistant"
          ? { ...m, actions: m.actions.map((a) => (a.id === actId ? { ...a, ...patch } : a)) }
          : m
      )
    );
  }, []);

  /** Fold a dispatcher result into an action's UI state; run client side-effects. */
  const applyResult = useCallback(
    (
      out: AssistantActionResult,
      name: string,
      params?: Record<string, unknown>
    ): Partial<ActionState> => {
      if (out.status === "done") {
        if (out.side === "client" || CLIENT_ACTIONS.has(name)) onClientAction(name, params || {});
        const runId = name === "spawn_run" && out.result?.id ? String(out.result.id) : undefined;
        return { status: "done", busy: false, note: doneLabel(name, params), runId };
      }
      if (out.status === "needs_confirm") {
        return {
          status: "needs_confirm",
          busy: false,
          confirmToken: out.confirmToken,
          requiresTyped: out.requiresTyped,
          note: out.requiresTyped ? "Name didn't match - retype it exactly." : undefined,
        };
      }
      return {
        status: out.status,
        busy: false,
        note: out.reason || out.error || "Not executed.",
      };
    },
    [onClientAction]
  );

  /** Build render-state actions from an ask response; execute done client actions. */
  const buildActions = useCallback(
    (list: AssistantAction[]): ActionState[] =>
      list.map((a) => {
        const st: ActionState = {
          id: uid(),
          name: a.name,
          params: a.params,
          status: a.status,
          confirmToken: a.confirmToken,
          requiresTyped: a.requiresTyped,
        };
        if (a.status === "done") {
          if (a.side === "client" || CLIENT_ACTIONS.has(a.name))
            onClientAction(a.name, a.params || {});
          st.note = doneLabel(a.name, a.params);
          if (a.name === "spawn_run" && a.result?.id) st.runId = String(a.result.id);
        } else if (a.status === "denied" || a.status === "error") {
          st.note = a.reason || a.error || "Not executed.";
        }
        return st;
      }),
    [onClientAction]
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;
      setMessages((m) => [...m, { id: uid(), role: "user", text }]);
      setInput("");

      // Fast path: status/errors/waiting answered instantly, offline, zero tokens.
      const local = matchIntent(text, status);
      if (local.kind === "answer") {
        setMessages((m) => [
          ...m,
          { id: uid(), role: "assistant", text: local.text, provider: "local", actions: [] },
        ]);
        return;
      }

      setLoading(true);
      onThinking?.(true);
      try {
        const res = await api.assistant.ask(text, {
          source: "chat",
          conversationId: convoId.current ?? undefined,
          provider: provider || undefined,
          context: { page: typeof window !== "undefined" ? window.location.pathname : undefined },
        });
        convoId.current = res.conversationId;
        if (res.requestedProvider) {
          // The requested provider failed and a fallback answered instead - say
          // so plainly instead of silently repinning the picker to the fallback,
          // which would hide the failure and quietly "switch" the user's choice.
          setMessages((m) => [
            ...m,
            {
              id: uid(),
              role: "assistant",
              text: `⚠️ ${res.requestedProvider} failed (${res.providerError || "unknown error"}) — answered via ${res.provider || "fallback"} instead.`,
              actions: [],
            },
          ]);
        } else if (res.provider && res.provider !== "local" && KNOWN_PROVIDERS.has(res.provider)) {
          // A spoken directive ("use claude") deliberately switched the provider.
          pickProvider(res.provider);
        }
        setMessages((m) => [
          ...m,
          {
            id: uid(),
            role: "assistant",
            text: res.text,
            provider: res.provider,
            actions: buildActions(res.actions || []),
          },
        ]);
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: uid(), role: "assistant", text: `⚠️ ${errText(e)}`, actions: [] },
        ]);
      } finally {
        setLoading(false);
        onThinking?.(false);
      }
    },
    [loading, status, provider, onThinking, pickProvider, buildActions]
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  /** Tap a confirm chip: re-send the action with its token to execute it. */
  const confirmAction = useCallback(
    async (msgId: string, act: ActionState) => {
      patchAction(msgId, act.id, { busy: true });
      try {
        const out = await api.assistant.action({
          name: act.name,
          params: act.params,
          confirmToken: act.confirmToken,
        });
        patchAction(msgId, act.id, applyResult(out, act.name, act.params));
      } catch (e) {
        patchAction(msgId, act.id, { busy: false, status: "error", note: errText(e) });
      }
    },
    [patchAction, applyResult]
  );

  /** Submit a typed confirmation (retyped action name) for a `typed`-risk action. */
  const typedConfirm = useCallback(
    async (msgId: string, act: ActionState, typed: string) => {
      patchAction(msgId, act.id, { busy: true });
      try {
        const out = await api.assistant.action({
          name: act.name,
          params: act.params,
          typedConfirm: typed,
        });
        patchAction(msgId, act.id, applyResult(out, act.name, act.params));
      } catch (e) {
        patchAction(msgId, act.id, { busy: false, status: "error", note: errText(e) });
      }
    },
    [patchAction, applyResult]
  );

  /** Explicit handoff: spawn a real agent run for a prior prompt (Phase M2 step 7). */
  const runAsAgent = useCallback(
    async (text: string) => {
      if (loading) return;
      setLoading(true);
      onThinking?.(true);
      try {
        const out = await api.assistant.action({ name: "spawn_run", params: { prompt: text } });
        const act: ActionState = {
          id: uid(),
          name: "spawn_run",
          params: { prompt: text },
          status: out.status,
          confirmToken: out.confirmToken,
          requiresTyped: out.requiresTyped,
        };
        Object.assign(act, applyResult(out, "spawn_run", { prompt: text }));
        act.status = out.status; // applyResult keeps status; keep needs_confirm chip
        setMessages((m) => [
          ...m,
          { id: uid(), role: "assistant", text: "Spawn an agent to run that?", actions: [act] },
        ]);
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: uid(), role: "assistant", text: `⚠️ ${errText(e)}`, actions: [] },
        ]);
      } finally {
        setLoading(false);
        onThinking?.(false);
      }
    },
    [loading, onThinking, applyResult]
  );

  const widthClass = sheet ? "w-full" : big ? "w-96" : "w-72";
  const transcriptMax = sheet ? "max-h-[55vh]" : big ? "max-h-96" : "max-h-56";

  return (
    <div
      className={`${widthClass} flex flex-col overflow-hidden ${
        sheet ? "rounded-t-2xl" : "rounded-2xl"
      } border border-border-light bg-surface-2/95 shadow-2xl shadow-black/50 backdrop-blur-md animate-slide-up`}
      role="dialog"
      aria-label="JARVIS companion"
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-gradient-to-r from-accent/10 to-transparent px-3.5 py-2.5">
        <div
          className={`flex items-center gap-2 min-w-0 ${!sheet ? "cursor-move select-none" : ""}`}
          {...(!sheet ? { "data-tabby-drag-handle": "1" } : {})}
          title={!sheet ? "Drag to move · double-click to reset position" : undefined}
        >
          <Orbit size={16} className="shrink-0 text-accent" aria-hidden />
          <span className="text-sm font-semibold text-gray-100">MINI JARVIS</span>
          <span
            className={`ml-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              status.connected ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                status.connected ? "bg-emerald-400" : "bg-red-500"
              }`}
              aria-hidden
            />
            {status.connected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {providers.length > 0 && (
            <select
              className="max-w-[6.5rem] truncate rounded-md border border-border bg-surface-1 px-1.5 py-1 text-[11px] text-gray-300 focus:border-accent focus:outline-none"
              value={provider}
              onChange={(e) => pickProvider(e.target.value)}
              aria-label="Assistant provider"
              title="Which model answers"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          {!sheet && (
            <button
              className="rounded-md p-1 text-gray-500 transition-colors hover:bg-surface-4 hover:text-gray-200"
              onClick={toggleExpanded}
              aria-label={expanded ? "Collapse panel" : "Expand panel"}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            className="rounded-md p-1 text-gray-500 transition-colors hover:bg-surface-4 hover:text-gray-200"
            onClick={onClose}
            aria-label="Close JARVIS companion"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {/* status stat chips */}
        <div className="mb-3 grid grid-cols-3 gap-1.5">
          <StatChip
            icon={Radio}
            label="live"
            value={status.liveCount}
            tone={status.liveCount > 0 ? "accent" : "muted"}
          />
          <StatChip
            icon={Hourglass}
            label="waiting"
            value={status.waitingCount}
            tone={status.waitingCount > 0 ? "amber" : "muted"}
          />
          <StatChip
            icon={AlertTriangle}
            label="errored"
            value={status.errorCount}
            tone={status.errorCount > 0 ? "red" : "muted"}
          />
        </div>

        {/* transcript / empty state */}
        {messages.length === 0 ? (
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            <ActionButton icon={Play} label="Run Claude" onClick={() => onNavigate("/run")} />
            <ActionButton
              icon={Activity}
              label="Activity"
              onClick={() => onNavigate("/activity")}
            />
            <ActionButton
              icon={LayoutList}
              label="Sessions"
              onClick={() => onNavigate("/sessions")}
            />
            <ActionButton
              icon={AlertTriangle}
              label="Errored"
              disabled={status.errorCount === 0}
              onClick={() => onNavigate("/sessions")}
            />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className={`mb-2 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1 ${transcriptMax}`}
          >
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex flex-col items-end gap-0.5">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/15 px-3 py-1.5 text-xs text-gray-100">
                    {m.text}
                  </div>
                  <button
                    className="flex items-center gap-1 text-[10px] text-gray-500 transition-colors hover:text-accent"
                    onClick={() => runAsAgent(m.text)}
                    disabled={loading}
                    title="Spawn a real agent run for this"
                  >
                    <Bot size={11} /> Run as agent
                  </button>
                </div>
              ) : (
                <div key={m.id} className="flex flex-col items-start gap-1">
                  <div className="max-w-full rounded-2xl rounded-bl-sm bg-surface-1/80 px-3 py-2">
                    <MarkdownContent text={m.text} dense />
                  </div>
                  {m.actions.map((a) => (
                    <ActionChip
                      key={a.id}
                      action={a}
                      onConfirm={() => confirmAction(m.id, a)}
                      onTyped={(t) => typedConfirm(m.id, a, t)}
                      onOpenRun={(id) => onNavigate(`/run/${id}`)}
                    />
                  ))}
                  {m.provider && m.provider !== "local" && (
                    <span className="pl-1 text-[10px] uppercase tracking-wider text-gray-600">
                      {m.provider}
                    </span>
                  )}
                </div>
              )
            )}
            {loading && (
              <div className="flex items-center gap-1.5 pl-1 text-[11px] text-gray-500">
                <span className="tabby-typing-dot" />
                <span className="tabby-typing-dot" style={{ animationDelay: "0.15s" }} />
                <span className="tabby-typing-dot" style={{ animationDelay: "0.3s" }} />
              </div>
            )}
          </div>
        )}

        {/* control row */}
        <div className="mb-2 flex items-center gap-1">
          <IconToggle
            icon={muted ? BellOff : Bell}
            label={muted ? "Unmute" : "Mute"}
            active={muted}
            onClick={onToggleMute}
          />
          <IconToggle
            icon={asleep ? Sun : Moon}
            label={asleep ? "Wake up" : "Sleep"}
            active={asleep}
            onClick={onToggleSleep}
          />
          <IconToggle
            icon={Trash2}
            label="Clear alerts"
            disabled={status.errorCount === 0}
            onClick={onClearAlerts}
          />
          <IconToggle
            icon={Eraser}
            label="Clear chat"
            disabled={messages.length === 0}
            onClick={clearConversation}
          />
        </div>

        {/* ask */}
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <input
            className="flex-1 rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            placeholder="Ask or tell JARVIS…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Ask JARVIS"
            disabled={loading}
          />
          <button
            type="submit"
            className="flex items-center justify-center rounded-lg bg-accent px-2.5 py-2 text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
            aria-label="Send"
            disabled={loading}
          >
            <Send size={14} />
          </button>
        </form>
      </div>
    </div>
  );
}

/** A confirm/typed chip or a resolved-outcome line for one action. */
function ActionChip({
  action,
  onConfirm,
  onTyped,
  onOpenRun,
}: {
  action: ActionState;
  onConfirm: () => void;
  onTyped: (typed: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [typed, setTyped] = useState("");

  if (action.status === "needs_confirm" && action.requiresTyped) {
    return (
      <form
        className="flex w-full items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onTyped(typed);
        }}
      >
        <ShieldAlert size={13} className="shrink-0 text-amber-400" aria-hidden />
        <input
          className="min-w-0 flex-1 rounded border border-amber-500/30 bg-surface-1 px-1.5 py-1 text-[11px] text-gray-200 placeholder-gray-500 focus:outline-none"
          placeholder={`type "${action.name}" to run`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={`Confirm ${action.name}`}
          disabled={action.busy}
        />
        <button
          type="submit"
          className="rounded bg-amber-500/80 px-2 py-1 text-[11px] font-medium text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
          disabled={action.busy}
        >
          Run
        </button>
      </form>
    );
  }

  if (action.status === "needs_confirm") {
    return (
      <div className="flex w-full items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-300">
          {doneLabel(action.name, action.params)}?
        </span>
        <button
          className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          onClick={onConfirm}
          disabled={action.busy}
        >
          Confirm
        </button>
      </div>
    );
  }

  // Resolved (done / denied / error).
  const good = action.status === "done";
  return (
    <div
      className={`flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] ${
        good ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"
      }`}
    >
      {good ? (
        <Check size={12} className="shrink-0" aria-hidden />
      ) : (
        <ShieldAlert size={12} className="shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{action.note || doneLabel(action.name)}</span>
      {action.runId && (
        <button
          className="shrink-0 rounded bg-surface-4 px-1.5 py-0.5 font-medium text-accent hover:bg-surface-3"
          onClick={() => onOpenRun(action.runId as string)}
        >
          Open run →
        </button>
      )}
    </div>
  );
}

interface Tone {
  wrap: string;
  value: string;
  icon: string;
}

const TONE_MUTED: Tone = {
  wrap: "border-border bg-surface-1",
  value: "text-gray-300",
  icon: "text-gray-500",
};

const TONES: Record<string, Tone> = {
  accent: { wrap: "border-accent/30 bg-accent/10", value: "text-gray-100", icon: "text-accent" },
  amber: {
    wrap: "border-amber-500/30 bg-amber-500/10",
    value: "text-amber-200",
    icon: "text-amber-400",
  },
  red: { wrap: "border-red-500/30 bg-red-500/10", value: "text-red-200", icon: "text-red-400" },
  muted: TONE_MUTED,
};

function StatChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: string;
}): ReactNode {
  const t = TONES[tone] ?? TONE_MUTED;
  return (
    <div className={`flex flex-col items-center gap-0.5 rounded-xl border py-1.5 ${t.wrap}`}>
      <Icon size={13} className={t.icon} aria-hidden />
      <span className={`text-base font-semibold leading-none tabular-nums ${t.value}`}>
        {value}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-gray-500">{label}</span>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg bg-surface-1 px-2 py-1.5 text-xs text-gray-300 transition-colors hover:bg-surface-4 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function IconToggle({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-accent/15 text-accent"
          : "bg-surface-1 text-gray-400 hover:bg-surface-4 hover:text-gray-200"
      }`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
