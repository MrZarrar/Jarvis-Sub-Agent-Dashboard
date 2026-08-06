import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  Archive,
  Bot,
  Check,
  CircleStop,
  Copy,
  FileText,
  GitFork,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  X,
  Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { formatDateTime, timeAgo, truncate } from "../lib/format";
import type {
  Mission,
  MissionDetail,
  MissionDomain,
  MissionModelTier,
  ProviderCapabilities,
  WSMessage,
} from "../lib/types";
import type { CodexRemotePair, CodexRemoteStatus } from "../lib/api";

const STATUS: Record<string, string> = {
  queued: "text-slate-300 border-slate-500/30 bg-slate-500/10",
  planning: "text-violet-300 border-violet-500/30 bg-violet-500/10",
  delegated: "text-blue-300 border-blue-500/30 bg-blue-500/10",
  running: "text-cyan-300 border-cyan-500/30 bg-cyan-500/10",
  waiting_approval: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  blocked: "text-orange-300 border-orange-500/30 bg-orange-500/10",
  completed: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  failed: "text-red-300 border-red-500/30 bg-red-500/10",
  cancelled: "text-gray-400 border-gray-500/30 bg-gray-500/10",
};

const DOMAINS: MissionDomain[] = ["personal", "development", "business", "generic"];
const TIERS: MissionModelTier[] = ["fast", "standard", "executor", "deep_review"];

export function Missions() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState<Mission[]>([]);
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [providers, setProviders] = useState<ProviderCapabilities | null>(null);
  const [remote, setRemote] = useState<CodexRemoteStatus | null>(null);
  const [pair, setPair] = useState<CodexRemotePair | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(() => localStorage.getItem("jarvis-quiet") === "1");

  const load = useCallback(async () => {
    try {
      const [missions, capabilities, remoteStatus] = await Promise.all([
        api.missions.list(),
        api.providers.capabilities(),
        api.codexRemote.status(),
      ]);
      setItems(missions.items);
      setProviders(capabilities);
      setRemote(remoteStatus);
      if (id) setDetail(await api.missions.get(id));
      else setDetail(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load missions");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    return eventBus.subscribe((message: WSMessage) => {
      if (message.type === "mission.event" || message.type === "mission.delta") load();
    });
  }, [load]);

  useEffect(() => {
    if (!pair?.expiresAt) return;
    const delay = Math.max(0, Date.parse(pair.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setPair(null), delay);
    return () => window.clearTimeout(timer);
  }, [pair]);

  const active = items.filter((mission) =>
    ["queued", "planning", "delegated", "running", "waiting_approval", "blocked"].includes(
      mission.status
    )
  );
  const needsYou = items.filter((mission) =>
    ["waiting_approval", "blocked", "failed"].includes(mission.status)
  );
  const hudState = needsYou.some((mission) => mission.status === "waiting_approval")
    ? "waiting for approval"
    : active.some((mission) => mission.status === "delegated")
      ? "delegating"
      : active.some((mission) => mission.status === "running")
        ? "executing"
        : active.some((mission) => mission.status === "planning")
          ? "planning"
          : "ready";

  const setQuietMode = (value: boolean) => {
    setQuiet(value);
    localStorage.setItem("jarvis-quiet", value ? "1" : "0");
  };

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading command center…</div>;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-full border flex items-center justify-center shadow-[0_0_28px_rgba(0,194,232,.2)] ${
              needsYou.length
                ? "border-amber-400/60 bg-amber-400/10"
                : "border-cyan-400/60 bg-cyan-400/10"
            }`}
            aria-label={`System state: ${hudState}`}
          >
            <Zap className={`w-5 h-5 ${needsYou.length ? "text-amber-300" : "text-cyan-300"}`} />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.28em] text-cyan-400">Command center</p>
            <h1 className="text-xl font-semibold text-gray-50">Missions</h1>
            <p className="text-xs text-gray-500 capitalize">
              {hudState} · {active.length} active · {needsYou.length} need you
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-gray-400 px-3 py-2 rounded-lg border border-border bg-surface-2">
            <input
              type="checkbox"
              checked={quiet}
              onChange={(e) => setQuietMode(e.target.checked)}
            />
            Quiet mode
          </label>
          <button
            type="button"
            onClick={load}
            className="p-2 rounded-lg border border-border text-gray-400 hover:text-white"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
        <main className="space-y-5">
          {!id && <MissionComposer onCreated={(mission) => navigate(`/missions/${mission.id}`)} />}
          {id && detail ? (
            <MissionView
              detail={detail}
              onChanged={load}
              onClose={() => navigate("/missions")}
              quiet={quiet}
            />
          ) : id ? (
            <div className="card p-6 text-sm text-gray-400">
              Imported Codex history remains available in Sessions. Resume it by starting a
              continuation mission.
            </div>
          ) : (
            <MissionList items={items} />
          )}
        </main>

        <aside className="space-y-4">
          <SystemHealth capabilities={providers} />
          <RemoteCard remote={remote} pair={pair} onRemote={setRemote} onPair={setPair} />
          {!quiet && (
            <div className="card p-4 text-xs text-gray-500 space-y-2">
              <p className="text-gray-300 font-medium">Routing policy</p>
              <p>Personal + Business → Codex</p>
              <p>Development → GPT-5.6 Sol owner + Claude Code team</p>
              <p>Generic chat and bounded actions → signed-in Codex</p>
              <p className="text-amber-300/80">No silent provider or API-billing fallback.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function MissionComposer({ onCreated }: { onCreated: (mission: Mission) => void }) {
  const [prompt, setPrompt] = useState("");
  const [domain, setDomain] = useState<MissionDomain>("personal");
  const [tier, setTier] = useState<MissionModelTier | "auto">("auto");
  const [workspace, setWorkspace] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.missions.create({
        prompt: prompt.trim(),
        domain,
        interaction: domain === "generic" ? "conversation" : "durable_mission",
        modelTier: tier === "auto" ? undefined : tier,
        workspace: workspace.trim() || undefined,
        origin: window.innerWidth < 768 ? "mobile" : "desktop",
      });
      onCreated(result.mission);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mission failed to start");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-4 space-y-3 border-cyan-500/20">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-gray-200">New mission</span>
        <span className="text-[10px] text-gray-600">⌘K opens command palette</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {DOMAINS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setDomain(item)}
            className={`px-3 py-1.5 rounded-lg text-xs capitalize border ${
              domain === item
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
                : "border-border text-gray-500"
            }`}
          >
            {item}
          </button>
        ))}
      </div>
      <textarea
        id="mission-command"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="State the outcome. Jarvis will choose the execution lane and record why."
        className="w-full rounded-xl bg-surface-2 border border-border px-3 py-3 text-sm text-gray-100 placeholder-gray-600 focus:border-cyan-500/50 focus:outline-none resize-y"
      />
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
        <input
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="Workspace (optional)"
          className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-200 focus:outline-none"
        />
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as MissionModelTier | "auto")}
          className="rounded-lg bg-surface-2 border border-border px-3 py-2 text-xs text-gray-200"
        >
          <option value="auto">Auto tier</option>
          {TIERS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button
          disabled={submitting || !prompt.trim()}
          className="rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 px-4 py-2 text-sm disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          Launch
        </button>
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </form>
  );
}

function MissionList({ items }: { items: Mission[] }) {
  const groups = useMemo(
    () =>
      DOMAINS.map((domain) => ({
        domain,
        items: items.filter((mission) => mission.domain === domain),
      })),
    [items]
  );
  return (
    <div className="space-y-5">
      {groups.map(({ domain, items: rows }) =>
        rows.length ? (
          <section key={domain} className="space-y-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-gray-500">{domain}</h2>
            {rows.map((mission) => (
              <Link
                key={mission.id}
                to={`/missions/${mission.id}`}
                className="card block p-4 hover:border-cyan-500/25 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-100 truncate">{mission.title}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {truncate(
                        mission.result_summary || mission.routing_reason || mission.prompt,
                        180
                      )}
                    </p>
                  </div>
                  <StatusPill mission={mission} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-gray-500">
                  <span>{mission.owner_provider}</span>
                  {mission.worker_provider && <span>→ {mission.worker_provider}</span>}
                  <span>{mission.owner_model_tier}</span>
                  <span>{timeAgo(mission.updated_at)}</span>
                </div>
              </Link>
            ))}
          </section>
        ) : null
      )}
      {!items.length && (
        <div className="card p-10 text-center text-sm text-gray-500">No missions yet.</div>
      )}
    </div>
  );
}

function StatusPill({ mission }: { mission: Mission }) {
  return (
    <span
      className={`flex-shrink-0 rounded-md border px-2 py-1 text-[10px] capitalize ${STATUS[mission.status] || STATUS.queued}`}
    >
      {mission.status.replace(/_/g, " ")}
    </span>
  );
}

function MissionView({
  detail,
  onChanged,
  onClose,
  quiet,
}: {
  detail: MissionDetail;
  onChanged: () => void;
  onClose: () => void;
  quiet: boolean;
}) {
  const { mission, events, approvals, children, artifacts } = detail;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <button onClick={onClose} className="text-[11px] text-cyan-400 hover:underline">
              ← All missions
            </button>
            <h2 className="mt-2 text-lg font-semibold text-gray-100">{mission.title}</h2>
            <p className="mt-1 text-sm text-gray-400 whitespace-pre-wrap">{mission.prompt}</p>
          </div>
          <StatusPill mission={mission} />
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Meta label="Lane" value={mission.domain} />
          <Meta
            label="Owner"
            value={`${mission.owner_provider}${mission.worker_provider ? ` → ${mission.worker_provider}` : ""}`}
          />
          <Meta label="Tier" value={mission.owner_model_tier} />
          <Meta
            label="Access"
            value={mission.owner_provider === "codex" ? "subscription CLI" : mission.owner_provider}
          />
        </div>
        <p className="mt-3 text-xs text-cyan-300/80">{mission.routing_reason}</p>
        {mission.error && <p className="mt-2 text-xs text-red-300">{mission.error}</p>}
      </div>

      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          busy={busy}
          onResolve={(decision, response) =>
            act(() => api.missions.approval(mission.id, approval.id, decision, response))
          }
        />
      ))}

      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {mission.controls.interrupt && (
            <button
              disabled={busy}
              onClick={() => act(() => api.missions.interrupt(mission.id))}
              className="control-btn"
            >
              <CircleStop className="w-3.5 h-3.5" /> Interrupt
            </button>
          )}
          {mission.controls.retry && (
            <button
              disabled={busy}
              onClick={() => act(() => api.missions.retry(mission.id))}
              className="control-btn"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          )}
          {mission.controls.fork && (
            <button
              disabled={busy}
              onClick={() => act(() => api.missions.fork(mission.id))}
              className="control-btn"
            >
              <GitFork className="w-3.5 h-3.5" /> Fork
            </button>
          )}
          {mission.controls.archive && (
            <button
              disabled={busy}
              onClick={() => act(() => api.missions.archive(mission.id))}
              className="control-btn"
            >
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
          )}
          {mission.run_id && (
            <Link to={`/run?runId=${encodeURIComponent(mission.run_id)}`} className="control-btn">
              <Bot className="w-3.5 h-3.5" /> Open worker
            </Link>
          )}
          {mission.origin === "import" && (
            <Link
              to={`/sessions/${encodeURIComponent(mission.id.replace("imported:", ""))}`}
              className="control-btn"
            >
              <Bot className="w-3.5 h-3.5" /> Imported transcript
            </Link>
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Steer or continue this mission…"
            className="flex-1 rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-200 focus:outline-none"
          />
          <button
            disabled={busy || !message.trim()}
            onClick={() =>
              act(async () => {
                await api.missions.steer(mission.id, message);
                setMessage("");
              })
            }
            className="px-3 rounded-lg border border-cyan-500/30 text-cyan-300 disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {children.length > 0 && (
        <div className="card p-4">
          <p className="text-xs font-medium text-gray-300 mb-2">Delegated workers</p>
          {children.map((child) => (
            <div key={child.id} className="flex justify-between text-xs text-gray-500 py-1">
              <span>
                {child.kind} · {child.provider}
              </span>
              <span>{child.status}</span>
            </div>
          ))}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="card p-4">
          <p className="text-xs font-medium text-gray-300 mb-2">Changed artifacts</p>
          <div className="space-y-2">
            {artifacts.map((artifact) => {
              const isUrl = /^https?:\/\//i.test(artifact.uri);
              const content = (
                <>
                  <FileText className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                  <span className="truncate">{artifact.label || artifact.uri}</span>
                  <span className="ml-auto text-[10px] text-gray-600">{artifact.provider}</span>
                </>
              );
              return isUrl ? (
                <a
                  key={artifact.id}
                  href={artifact.uri}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-gray-300 hover:border-cyan-500/30"
                >
                  {content}
                </a>
              ) : (
                <div
                  key={artifact.id}
                  title={artifact.uri}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-gray-300"
                >
                  {content}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card p-4">
        <p className="text-xs font-medium text-gray-300 mb-3">Mission timeline</p>
        <ol className="space-y-3">
          {events
            .filter(
              (event) =>
                !quiet ||
                ["routing_decision", "waiting_approval", "completed", "failed", "blocked"].includes(
                  event.event
                )
            )
            .map((event) => (
              <li key={event.id} className="grid grid-cols-[8px_1fr] gap-3">
                <span className="mt-1.5 w-2 h-2 rounded-full bg-cyan-400/60" />
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-600">
                    <span className="uppercase text-cyan-400/70">
                      {event.event.replace(/_/g, " ")}
                    </span>
                    <span>{event.provider}</span>
                    <span>{formatDateTime(event.created_at)}</span>
                  </div>
                  {event.summary && (
                    <p className="mt-0.5 text-xs text-gray-400 whitespace-pre-wrap break-words">
                      {event.summary}
                    </p>
                  )}
                </div>
              </li>
            ))}
        </ol>
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  busy,
  onResolve,
}: {
  approval: MissionDetail["approvals"][number];
  busy: boolean;
  onResolve: (
    decision: "allow" | "deny",
    response?: {
      typedConfirm?: string;
      answers?: Record<string, { answers: string[] }>;
      content?: Record<string, unknown>;
    }
  ) => void;
}) {
  const params = approval.params;
  const questions = Array.isArray(params.questions)
    ? (params.questions as Array<{
        id?: string;
        header?: string;
        question?: string;
        options?: Array<{ label?: string }>;
      }>)
    : [];
  const schema =
    params.requestedSchema && typeof params.requestedSchema === "object"
      ? (params.requestedSchema as { properties?: Record<string, { title?: string }> })
      : null;
  const fields = Object.entries(schema?.properties || {});
  const [values, setValues] = useState<Record<string, string>>({});
  const actionName = String(params.actionName || params.tool || "action");
  const requiresTyped = Boolean(params.requiresTyped);
  const isUserInput = approval.method === "item/tool/requestUserInput";
  const isElicitation = approval.method === "mcpServer/elicitation/request";
  const ready = requiresTyped
    ? values.typed === actionName
    : isUserInput
      ? questions.every((question, index) => values[String(question.id || index)]?.trim())
      : true;

  const allow = () => {
    if (requiresTyped) return onResolve("allow", { typedConfirm: values.typed });
    if (isUserInput) {
      return onResolve("allow", {
        answers: Object.fromEntries(
          questions.map((question, index) => [
            String(question.id || index),
            { answers: [values[String(question.id || index)] || ""] },
          ])
        ),
      });
    }
    if (isElicitation) {
      return onResolve("allow", {
        content: Object.fromEntries(fields.map(([key]) => [key, values[key] || ""])),
      });
    }
    onResolve("allow");
  };

  return (
    <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 space-y-3">
      <div>
        <p className="text-sm text-amber-200">
          {isUserInput || isElicitation ? "Input needed" : "Approval required"}
        </p>
        <p className="mt-1 text-xs text-amber-100/70 break-words">
          {String(params.command || params.reason || params.message || approval.method)}
        </p>
      </div>
      {requiresTyped && (
        <input
          value={values.typed || ""}
          onChange={(event) => setValues({ ...values, typed: event.target.value })}
          placeholder={`Type “${actionName}” to confirm`}
          className="w-full rounded-lg bg-surface-2 border border-amber-500/30 px-3 py-2 text-sm text-gray-100"
        />
      )}
      {questions.map((question, index) => {
        const key = String(question.id || index);
        return (
          <label key={key} className="block text-xs text-amber-100/80">
            {question.question || question.header || "Response"}
            {question.options?.length ? (
              <select
                value={values[key] || ""}
                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                className="mt-1 w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
              >
                <option value="">Choose…</option>
                {question.options.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[key] || ""}
                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                className="mt-1 w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
              />
            )}
          </label>
        );
      })}
      {fields.map(([key, field]) => (
        <label key={key} className="block text-xs text-amber-100/80">
          {field.title || key}
          <input
            value={values[key] || ""}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
            className="mt-1 w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100"
          />
        </label>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy || !ready}
          onClick={allow}
          className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex gap-1 items-center disabled:opacity-40"
        >
          <Check className="w-3 h-3" /> {isUserInput || isElicitation ? "Submit" : "Allow once"}
        </button>
        <button
          disabled={busy}
          onClick={() => onResolve("deny")}
          className="px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-xs flex gap-1 items-center"
        >
          <X className="w-3 h-3" /> {isUserInput || isElicitation ? "Decline" : "Deny"}
        </button>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-0.5 text-gray-300 capitalize">{value}</p>
    </div>
  );
}

function SystemHealth({ capabilities }: { capabilities: ProviderCapabilities | null }) {
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-cyan-400" />
        <p className="text-sm text-gray-200">System health</p>
      </div>
      {capabilities?.providers.map((provider) => (
        <div key={provider.id} className="flex items-center justify-between gap-2 text-xs">
          <div className="min-w-0">
            <p className="text-gray-300">{provider.label}</p>
            <p className="text-[10px] text-gray-600 truncate">{provider.billingLabel}</p>
          </div>
          <span className={provider.available ? "text-emerald-400" : "text-red-400"}>
            {provider.available ? "ready" : "unavailable"}
          </span>
        </div>
      ))}
    </div>
  );
}

function RemoteCard({
  remote,
  pair,
  onRemote,
  onPair,
}: {
  remote: CodexRemoteStatus | null;
  pair: CodexRemotePair | null;
  onRemote: (value: CodexRemoteStatus) => void;
  onPair: (value: CodexRemotePair | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<CodexRemoteStatus>) => {
    setBusy(true);
    try {
      onRemote(await fn());
    } finally {
      setBusy(false);
    }
  };
  const createPair = async () => {
    setBusy(true);
    try {
      onPair(await api.codexRemote.pair());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Smartphone className="w-4 h-4 text-cyan-400" />
        <p className="text-sm text-gray-200">Remote access</p>
      </div>
      <p className="text-xs text-gray-500">
        Use the QR flow in Codex desktop for normal remote access. The CLI host below is
        experimental.
      </p>
      <details className="rounded-lg border border-border p-3 text-xs text-gray-400">
        <summary className="cursor-pointer select-none">
          Experimental CLI host · {remote?.running ? "running" : "stopped"}
        </summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {remote?.running ? (
            <button
              disabled={busy}
              onClick={() => run(api.codexRemote.stop)}
              className="control-btn"
            >
              <Pause className="w-3.5 h-3.5" /> Stop
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => run(api.codexRemote.start)}
              className="control-btn"
            >
              <Radio className="w-3.5 h-3.5" /> Start
            </button>
          )}
          <button disabled={busy || !remote?.running} onClick={createPair} className="control-btn">
            <ShieldCheck className="w-3.5 h-3.5" /> Pair
          </button>
        </div>
      </details>
      {pair && (
        <div className="rounded-lg bg-surface-2 border border-cyan-500/20 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-600">
            Short-lived pairing code
          </p>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard.writeText(pair.manualPairingCode || pair.pairingCode || "")
            }
            className="mt-1 flex items-center gap-2 font-mono text-lg text-cyan-300"
          >
            <Copy className="w-3.5 h-3.5" />
            {pair.manualPairingCode || pair.pairingCode}
          </button>
          {pair.expiresAt && (
            <p className="mt-1 text-[10px] text-gray-600">
              Expires {formatDateTime(pair.expiresAt)}
            </p>
          )}
        </div>
      )}
      {remote?.handoffUrl && (
        <a
          href={remote.handoffUrl}
          target="_blank"
          rel="noreferrer"
          className="block text-xs text-cyan-400 hover:underline"
        >
          Open native Codex Remote ↗
        </a>
      )}
    </div>
  );
}
