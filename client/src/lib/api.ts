/**
 * @file api.ts
 * @description Defines a set of functions for interacting with the backend API of the agent dashboard application. It includes methods for fetching statistics, managing sessions and agents, retrieving analytics data, handling settings, and managing model pricing. The module abstracts away the details of making HTTP requests and provides a clean interface for the rest of the application to use when communicating with the server.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import type {
  AccountsState,
  Agent,
  AlertEvent,
  AlertRule,
  Analytics,
  AppNotification,
  ChatAttachment,
  LinkPreview,
  Briefing,
  BriefingKind,
  ProactiveConfig,
  Chat,
  ChatMessage,
  ChatProviderStatus,
  CostResult,
  DashboardEvent,
  ProvidersConfig,
  ModelPricing,
  Note,
  NoteMeta,
  NoteTag,
  NoteCapture,
  NotesConfig,
  VaultGraph,
  VaultNodeDetail,
  VaultPathStep,
  VaultEngineResult,
  VaultEngineStatus,
  VaultGraphifyStatus,
  DumpResult,
  GitHubOverviewResponse,
  GitHubConfig,
  ProjectPulse,
  ProjectPulseRow,
  PermissionDecision,
  PermissionEntry,
  Project,
  ProjectPath,
  ProjectRollup,
  ProjectStatus,
  ProjectWithRollup,
  ScheduledPrompt,
  ScheduleStatus,
  ScheduleStatusFilter,
  ScheduleTargetKind,
  ScheduleTriggerKind,
  Skill,
  SkillRun,
  SkillsConfig,
  Session,
  SessionDrillIn,
  SessionStats,
  Stats,
  TranscriptListResult,
  TranscriptResult,
  UpdateStatusPayload,
  WebhookDelivery,
  WebhookProvider,
  WebhookTarget,
  WebhookTestResult,
  WebhookType,
  WorkflowData,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowRunDetail,
  BrowseFramePayload,
  ComputerUseFramePayload,
} from "./types";

const BASE = "/api";

/**
 * Optional dashboard auth token (GHSA-gr74-4xfh-6jw9). Only needed when the
 * operator binds the server to a LAN and sets DASHBOARD_TOKEN; for the default
 * loopback bind there is no token and this returns null (zero-config). Read from
 * an injected global first, then localStorage so a LAN user can set it once.
 */
export function dashboardToken(): string | null {
  try {
    const injected = (globalThis as { __DASHBOARD_TOKEN__?: unknown }).__DASHBOARD_TOKEN__;
    if (typeof injected === "string" && injected) return injected;
    const stored = localStorage.getItem("dashboard_token");
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = dashboardToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { "x-dashboard-token": token } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface ChatStreamHandlers {
  onUser?: (m: ChatMessage) => void;
  onDelta?: (text: string) => void;
  onDone?: (m: ChatMessage) => void;
  onError?: (message: string) => void;
}

/**
 * POST a chat turn and consume the Server-Sent Events reply (Phase E). Resolves
 * when the stream ends; rejects only on transport failure (an in-band `error`
 * event is delivered via `handlers.onError` and still resolves, so a partial
 * transcript is preserved). Pass an AbortSignal to cancel mid-stream.
 */
export async function streamChatMessage(
  chatId: string,
  body: { text: string; provider?: string; model?: string; attachments?: ChatAttachment[] },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const token = dashboardToken();
  const res = await fetch(`${BASE}/chat/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-dashboard-token": token } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b?.error?.message || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (raw: string) => {
    let event = "message";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const p = payload as Record<string, unknown>;
    if (event === "user") handlers.onUser?.(p as unknown as ChatMessage);
    else if (event === "delta") handlers.onDelta?.(String(p.text || ""));
    else if (event === "done") handlers.onDone?.(p.message as ChatMessage);
    else if (event === "error") handlers.onError?.(String(p.message || "stream error"));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (block.trim()) dispatch(block);
    }
  }
  if (buf.trim()) dispatch(buf);
}

export const api = {
  updates: {
    status: () => request<UpdateStatusPayload>("/updates/status"),
    check: () =>
      request<UpdateStatusPayload>("/updates/check", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  },

  stats: {
    get: () => request<Stats>(`/stats?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  sessions: {
    facets: () => request<{ cwds: string[] }>("/sessions/facets"),
    list: (params?: {
      status?: string;
      q?: string;
      cwd?: string;
      sort_by?: string;
      sort_desc?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.q) qs.set("q", params.q);
      if (params?.cwd) qs.set("cwd", params.cwd);
      if (params?.sort_by) qs.set("sort_by", params.sort_by);
      if (params?.sort_desc !== undefined) qs.set("sort_desc", String(params.sort_desc));
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const queryString = qs.toString();
      return request<{ sessions: Session[]; total: number; limit: number; offset: number }>(
        `/sessions${queryString ? `?${queryString}` : ""}`
      );
    },
    get: (id: string) =>
      request<{
        session: Session;
        agents: Agent[];
        events: DashboardEvent[];
        workflows: WorkflowRun[];
      }>(`/sessions/${encodeURIComponent(id)}`),
    stats: (id: string) => request<SessionStats>(`/sessions/${encodeURIComponent(id)}/stats`),
    transcripts: (id: string) =>
      request<TranscriptListResult>(`/sessions/${encodeURIComponent(id)}/transcripts`),
    transcript: (
      id: string,
      params?: {
        agent_id?: string;
        run_id?: string;
        limit?: number;
        offset?: number;
        after?: number;
        before?: number;
      }
    ) => {
      const qs = new URLSearchParams();
      if (params?.agent_id) qs.set("agent_id", params.agent_id);
      if (params?.run_id) qs.set("run_id", params.run_id);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      if (params?.after != null) qs.set("after", String(params.after));
      if (params?.before != null) qs.set("before", String(params.before));
      const q = qs.toString();
      return request<TranscriptResult>(
        `/sessions/${encodeURIComponent(id)}/transcript${q ? `?${q}` : ""}`
      );
    },
  },

  agents: {
    list: (params?: { status?: string; session_id?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.session_id) qs.set("session_id", params.session_id);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{ agents: Agent[] }>(`/agents${q ? `?${q}` : ""}`);
    },
  },

  events: {
    list: (params?: {
      event_type?: string[];
      tool_name?: string[];
      agent_id?: string[];
      session_id?: string | string[];
      q?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      const csv = (v?: string[]) => (v && v.length > 0 ? v.join(",") : undefined);
      const et = csv(params?.event_type);
      const tn = csv(params?.tool_name);
      const ag = csv(params?.agent_id);
      const sid = Array.isArray(params?.session_id) ? csv(params?.session_id) : params?.session_id;
      if (et) qs.set("event_type", et);
      if (tn) qs.set("tool_name", tn);
      if (ag) qs.set("agent_id", ag);
      if (sid) qs.set("session_id", sid);
      if (params?.q) qs.set("q", params.q);
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{
        events: DashboardEvent[];
        limit: number;
        offset: number;
        total: number;
      }>(`/events${q ? `?${q}` : ""}`);
    },
    facets: () => request<{ event_types: string[]; tool_names: string[] }>("/events/facets"),
  },

  analytics: {
    get: () => request<Analytics>(`/analytics?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  settings: {
    info: () =>
      request<{
        db: {
          path: string;
          size: number;
          counts: Record<string, number>;
          pragmas: {
            journal_mode: string;
            synchronous: number;
            auto_vacuum: number;
            encoding: string;
            foreign_keys: number;
            busy_timeout: number;
          };
          load_stats: { m5: number; m15: number; h1: number };
        };
        hooks: { installed: boolean; path: string; hooks: Record<string, boolean> };
        server: {
          uptime: number;
          node_version: string;
          platform: string;
          ws_connections: number;
          memory: { rss: number; heapTotal: number; heapUsed: number; external: number };
          cpu_load: number[];
          arch: string;
          total_mem: number;
          free_mem: number;
          cpus: number;
        };
        transcript_cache: {
          size: number;
          maxSize: number;
          hits: number;
          misses: number;
          keys: string[];
        };
      }>("/settings/info"),
    claudeHome: {
      get: () => request<{ claude_home: string }>("/settings/claude-home"),
      set: (path: string) =>
        request<{ ok: boolean; claude_home: string }>("/settings/claude-home", {
          method: "PUT",
          body: JSON.stringify({ path }),
        }),
    },
    clearData: () =>
      request<{ ok: boolean; cleared: Record<string, number> }>("/settings/clear-data", {
        method: "POST",
      }),
    reimport: () =>
      request<{ ok: boolean; imported: number; skipped: number; errors: number }>(
        "/settings/reimport",
        { method: "POST" }
      ),
    reinstallHooks: () =>
      request<{ ok: boolean; hooks: { installed: boolean; hooks: Record<string, boolean> } }>(
        "/settings/reinstall-hooks",
        { method: "POST" }
      ),
    resetPricing: () =>
      request<{ ok: boolean; pricing: ModelPricing[] }>("/settings/reset-pricing", {
        method: "POST",
      }),
    exportData: () => `${BASE}/settings/export`,
    cleanup: (params: { abandon_hours?: number; purge_days?: number }) =>
      request<{
        ok: boolean;
        abandoned: number;
        purged_sessions: number;
        purged_events: number;
        purged_agents: number;
      }>("/settings/cleanup", { method: "POST", body: JSON.stringify(params) }),
    // Assistant file/shell access allowlist (Phase M, §3.1) - empty by default,
    // scopes read_file/write_file/list_dir/shell for the assistant action layer.
    assistantRoots: {
      get: () => request<{ roots: string[] }>("/settings/assistant-roots"),
      set: (roots: string[]) =>
        request<{ ok: boolean; roots: string[] }>("/settings/assistant-roots", {
          method: "PUT",
          body: JSON.stringify({ roots }),
        }),
    },
    // Assistant autonomy: the `claude_agent` delegate level (off|ask|auto).
    // "auto" lets Gemini fire the full Claude agent (web + agent-reach + shell)
    // inline with no confirmation.
    assistantAutonomy: {
      get: () => request<{ level: string }>("/settings/assistant-autonomy"),
      set: (level: string) =>
        request<{ ok: boolean; level: string }>("/settings/assistant-autonomy", {
          method: "PUT",
          body: JSON.stringify({ level }),
        }),
    },
    // Phase Z: opt read-only browse (computer use) into risk "safe" so Tabby/Siri
    // can drive the live browser view inline; false → it stays a one-tap confirm.
    browseSafe: {
      get: () => request<{ safe: boolean }>("/settings/browse-safe"),
      set: (safe: boolean) =>
        request<{ ok: boolean; safe: boolean }>("/settings/browse-safe", {
          method: "PUT",
          body: JSON.stringify({ safe }),
        }),
    },
    // Phase AF: feed verbosity - "agent" (default) collapses tool envelopes on
    // ambient surfaces (home Operations feed, ActivityFeed) behind expandable
    // agent rows; "tool" restores the per-envelope firehose.
    verbosity: {
      get: () => request<{ level: "agent" | "tool" }>("/settings/verbosity"),
      set: (level: "agent" | "tool") =>
        request<{ ok: boolean; level: "agent" | "tool" }>("/settings/verbosity", {
          method: "PUT",
          body: JSON.stringify({ level }),
        }),
    },
    // Phase Z Tier 2: opt real-desktop click/type (computer use) into risk
    // "safe" so Tabby/Siri can drive it inline; false → a one-tap confirm.
    computerUseSafe: {
      get: () => request<{ safe: boolean }>("/settings/computer-use-safe"),
      set: (safe: boolean) =>
        request<{ ok: boolean; safe: boolean }>("/settings/computer-use-safe", {
          method: "PUT",
          body: JSON.stringify({ safe }),
        }),
    },
  },

  workflows: {
    get: (status?: string) =>
      request<WorkflowData>(`/workflows${status && status !== "all" ? `?status=${status}` : ""}`),
    session: (id: string) =>
      request<SessionDrillIn>(`/workflows/session/${encodeURIComponent(id)}`),
    // Workflow-tool runs (issue #167) - fleets ingested from on-disk journals.
    runs: (params?: { status?: string; session_id?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status && params.status !== "all") qs.set("status", params.status);
      if (params?.session_id) qs.set("session_id", params.session_id);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<WorkflowRunsResponse>(`/workflows/runs${q ? `?${q}` : ""}`);
    },
    run: (runId: string) =>
      request<WorkflowRunDetail>(`/workflows/runs/${encodeURIComponent(runId)}`),
  },

  pricing: {
    list: () => request<{ pricing: ModelPricing[] }>("/pricing"),
    upsert: (data: Omit<ModelPricing, "updated_at">) =>
      request<{ pricing: ModelPricing }>("/pricing", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (pattern: string) =>
      request<{ ok: boolean }>(`/pricing/${encodeURIComponent(pattern)}`, {
        method: "DELETE",
      }),
    totalCost: () =>
      request<CostResult>(`/pricing/cost?tz_offset=${new Date().getTimezoneOffset()}`),
    sessionCost: (sessionId: string) =>
      request<CostResult>(
        `/pricing/cost/${encodeURIComponent(sessionId)}?tz_offset=${new Date().getTimezoneOffset()}`
      ),
  },

  import: {
    guide: () =>
      request<{
        platform: string;
        default_projects_dir: string;
        default_projects_dir_display: string;
        default_projects_dir_exists: boolean;
        default_projects_dir_stats: { projects: number; jsonl_files: number };
        archive_command: string;
        supported_extensions: string[];
        max_upload_bytes: number;
        max_upload_files: number;
        steps: { id: string; title: string; body: string }[];
      }>("/import/guide"),
    rescan: () => request<ImportResult>("/import/rescan", { method: "POST" }),
    scanPath: (path: string) =>
      request<ImportResult>("/import/scan-path", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    upload: async (files: File[]): Promise<ImportResult> => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      const res = await fetch(`${BASE}/import/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      return res.json();
    },
  },

  ccConfig: {
    overview: () => request<CcOverview>("/cc-config/overview"),
    skills: (scope?: CcScope) =>
      request<{ items: CcMdItem[] }>(`/cc-config/skills${scope ? `?scope=${scope}` : ""}`),
    agents: (scope?: CcScope) =>
      request<{ items: CcMdItem[] }>(`/cc-config/agents${scope ? `?scope=${scope}` : ""}`),
    commands: (scope?: CcScope) =>
      request<{ items: CcMdItem[] }>(`/cc-config/commands${scope ? `?scope=${scope}` : ""}`),
    outputStyles: (scope?: CcScope) =>
      request<{ items: CcMdItem[] }>(`/cc-config/output-styles${scope ? `?scope=${scope}` : ""}`),
    plugins: () => request<CcPluginsResponse>("/cc-config/plugins"),
    mcp: () => request<CcMcpResponse>("/cc-config/mcp"),
    hooks: () => request<{ items: CcHookSource[] }>("/cc-config/hooks"),
    settings: () => request<{ items: CcSettingsSource[] }>("/cc-config/settings"),
    memory: () => request<{ items: CcMemoryItem[] }>("/cc-config/memory"),
    file: (absPath: string) =>
      request<CcFileResponse>(`/cc-config/file?path=${encodeURIComponent(absPath)}`),
    write: (args: CcWriteArgs) =>
      request<CcMutationResult>("/cc-config/file", {
        method: "PUT",
        body: JSON.stringify(args),
      }),
    delete: (args: CcDeleteArgs) =>
      request<CcMutationResult>("/cc-config/file", {
        method: "DELETE",
        body: JSON.stringify(args),
      }),
    marketplaces: () => request<CcMarketplacesResponse>("/cc-config/marketplaces"),
    keybindings: () => request<CcKeybindings>("/cc-config/keybindings"),
    statusline: () => request<CcStatusline>("/cc-config/statusline"),
    hookScripts: () => request<CcHookScripts>("/cc-config/hook-scripts"),
    backups: (params?: { scope?: "user" | "project"; type?: CcArtifactType }) =>
      requestBackupsHelper(params),
  },

  run: {
    list: () => request<RunListResponse>("/run"),
    history: (limit = 50) =>
      request<{ items: DashboardRunHistoryItem[] }>(`/run/history?limit=${limit}`),
    binary: () => request<{ found: boolean; path: string | null }>("/run/binary"),
    providers: () => request<{ items: AgentProviderInfo[] }>("/run/providers"),
    cwds: () => request<{ items: CwdSuggestion[] }>("/run/cwds"),
    files: (cwd: string, q?: string) => {
      const qs = new URLSearchParams({ cwd });
      if (q) qs.set("q", q);
      return request<{ items: string[] }>(`/run/files?${qs.toString()}`);
    },
    start: (args: RunStartArgs) =>
      request<RunHandle>("/run", { method: "POST", body: JSON.stringify(args) }),
    get: (id: string, opts?: { envelopes?: boolean }) =>
      request<RunHandle>(`/run/${encodeURIComponent(id)}${opts?.envelopes ? "?envelopes=1" : ""}`),
    send: (id: string, text: string) =>
      request<{ messageId: string }>(`/run/${encodeURIComponent(id)}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    kill: (id: string) =>
      request<{ ok: true }>(`/run/${encodeURIComponent(id)}`, { method: "DELETE" }),
    permissions: (id: string) =>
      request<{ items: PermissionEntry[] }>(`/run/${encodeURIComponent(id)}/permissions`),
    resolvePermission: (
      id: string,
      requestId: string,
      decision: PermissionDecision,
      reason?: string
    ) =>
      request<{ request: PermissionEntry }>(
        `/run/${encodeURIComponent(id)}/permission/request/${encodeURIComponent(requestId)}`,
        { method: "POST", body: JSON.stringify({ decision, reason }) }
      ),
  },

  // Multi-account tracking (Phase K) - read-only claude-swap view.
  accounts: {
    get: () => request<AccountsState>("/accounts"),
  },

  // Projects (Phase F) - the dashboard-native organizing dimension over
  // sessions/runs/chats. Separate from Claude.ai's own Projects feature.
  projects: {
    list: (status?: ProjectStatus) =>
      request<{ items: ProjectWithRollup[] }>(`/projects${status ? `?status=${status}` : ""}`),
    get: (id: string) =>
      request<{
        project: Project;
        rollup: ProjectRollup;
        paths: ProjectPath[];
        pulse: ProjectPulseRow | null;
      }>(`/projects/${encodeURIComponent(id)}`),
    create: (args: {
      name: string;
      description?: string | null;
      status?: ProjectStatus;
      repoPath?: string | null;
      notesDir?: string | null;
    }) =>
      request<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify(args) }),
    update: (
      id: string,
      patch: {
        name?: string;
        description?: string | null;
        status?: ProjectStatus;
        repoPath?: string | null;
        notesDir?: string | null;
      }
    ) =>
      request<{ project: Project }>(`/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listPaths: (id: string) =>
      request<{ items: ProjectPath[] }>(`/projects/${encodeURIComponent(id)}/paths`),
    addPath: (id: string, repoPath: string) =>
      request<{ path: ProjectPath; backfilled: { sessions: number; runs: number } }>(
        `/projects/${encodeURIComponent(id)}/paths`,
        { method: "POST", body: JSON.stringify({ repoPath }) }
      ),
    removePath: (id: string, pathId: string) =>
      request<{ ok: true }>(
        `/projects/${encodeURIComponent(id)}/paths/${encodeURIComponent(pathId)}`,
        { method: "DELETE" }
      ),
    // Project pulse (Phase G2) - working/neglected/completed tracker.
    pulse: () => request<{ items: ProjectPulse[]; neglectDays: number }>("/projects/pulse"),
    recomputePulse: () =>
      request<{ items: ProjectPulse[]; neglectDays: number }>("/projects/pulse/recompute", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  },

  // Notes + brain-dump (Phase G). Notes are markdown files on disk indexed in
  // SQLite; the server owns the files and the FTS index.
  notes: {
    list: (params?: { q?: string; tag?: string; project?: string }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set("q", params.q);
      if (params?.tag) qs.set("tag", params.tag);
      if (params?.project) qs.set("project", params.project);
      const s = qs.toString();
      return request<{ items: NoteMeta[] }>(`/notes${s ? `?${s}` : ""}`);
    },
    get: (id: string) => request<{ note: Note }>(`/notes/${encodeURIComponent(id)}`),
    create: (args: { title?: string; body?: string; tags?: string[]; projectId?: string | null }) =>
      request<{ note: Note }>("/notes", { method: "POST", body: JSON.stringify(args) }),
    update: (
      id: string,
      patch: { title?: string; body?: string; tags?: string[]; projectId?: string | null }
    ) =>
      request<{ note: Note }>(`/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    tags: () => request<{ items: NoteTag[] }>("/notes/tags"),
    config: () => request<NotesConfig>("/notes/config"),
    setConfig: (dir: string) =>
      request<NotesConfig>("/notes/config", { method: "PUT", body: JSON.stringify({ dir }) }),
    dump: (args: { text: string; save?: boolean; projectId?: string | null; source?: string }) =>
      request<DumpResult>("/notes/dump", { method: "POST", body: JSON.stringify(args) }),
    captures: () => request<{ items: NoteCapture[] }>("/notes/captures"),
    fileCapture: (id: string, projectId?: string | null) =>
      request<{ note: Note }>(`/notes/captures/${encodeURIComponent(id)}/file`, {
        method: "POST",
        body: JSON.stringify(projectId ? { projectId } : {}),
      }),
    discardCapture: (id: string) =>
      request<{ ok: true }>(`/notes/captures/${encodeURIComponent(id)}/discard`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
  },

  // Knowledge vault (Phase S). The graph over the notes tree + the v1 writers.
  vault: {
    graph: () => request<VaultGraph>("/vault/graph"),
    node: (id: string) =>
      request<{ node: VaultNodeDetail }>(`/vault/node/${encodeURIComponent(id)}`),
    path: (from: string, to: string) =>
      request<{ path: VaultPathStep[] | null }>(
        `/vault/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      ),
    summaryProjects: () => request<{ projectIds: string[] }>("/vault/summary-projects"),
    setSummaryProjects: (projectIds: string[]) =>
      request<{ projectIds: string[] }>("/vault/summary-projects", {
        method: "PUT",
        body: JSON.stringify({ projectIds }),
      }),
    saveChat: (args: { chatId: string; mode?: "message" | "summary"; messageId?: string }) =>
      request<{ note: Note }>("/vault/save-chat", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    // Entity engine + graphify bridge (Phase T).
    engineRun: () =>
      request<VaultEngineResult>("/vault/engine/run", { method: "POST", body: "{}" }),
    engineStatus: () => request<VaultEngineStatus>("/vault/engine/status"),
    graphifyProjects: () => request<{ projectIds: string[] }>("/vault/graphify-projects"),
    setGraphifyProjects: (projectIds: string[]) =>
      request<{ projectIds: string[] }>("/vault/graphify-projects", {
        method: "PUT",
        body: JSON.stringify({ projectIds }),
      }),
    graphifyRun: (projectId: string) =>
      request<{ started: boolean; projectId: string }>("/vault/graphify/run", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    graphifyStatus: () => request<VaultGraphifyStatus>("/vault/graphify/status"),
  },

  // Notification inbox (Phase O). Rows are written server-side by the notify
  // facade; the Tabby ball's badge + Inbox tab read here.
  notifications: {
    list: (opts: { unread?: boolean; limit?: number } = {}) =>
      request<{ notifications: AppNotification[]; unread: number }>(
        `/notifications?${opts.unread ? "unread=1&" : ""}limit=${opts.limit ?? 50}`
      ),
    markRead: (id: string) =>
      request<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    readAll: () =>
      request<{ ok: true; marked: number }>("/notifications/read-all", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  },

  // Scheduled & chained prompts (Phase L).
  schedules: {
    list: (status?: ScheduleStatus) =>
      request<{ items: ScheduledPrompt[]; maxChainDepth: number }>(
        `/schedules${status ? `?status=${status}` : ""}`
      ),
    get: (id: string) =>
      request<{ schedule: ScheduledPrompt }>(`/schedules/${encodeURIComponent(id)}`),
    create: (args: ScheduleCreateArgs) =>
      request<{ schedule: ScheduledPrompt }>("/schedules", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    edit: (
      id: string,
      patch: {
        label?: string;
        prompt?: string;
        fireAt?: string;
        statusFilter?: ScheduleStatusFilter;
      }
    ) =>
      request<{ schedule: ScheduledPrompt }>(`/schedules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    cancel: (id: string, cascade = false) =>
      request<{ ok: true; cancelled: number }>(
        `/schedules/${encodeURIComponent(id)}${cascade ? "?cascade=1" : ""}`,
        { method: "DELETE" }
      ),
  },

  // Skills - tap-to-run automations (Phase H).
  skills: {
    list: () => request<{ items: Skill[] }>("/skills"),
    get: (id: string) => request<{ skill: Skill }>(`/skills/${encodeURIComponent(id)}`),
    create: (raw: string) =>
      request<{ skill: Skill }>("/skills", { method: "POST", body: JSON.stringify({ raw }) }),
    update: (id: string, raw: string) =>
      request<{ skill: Skill }>(`/skills/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ raw }),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
    run: (id: string, args?: { params?: Record<string, unknown>; confirmText?: string }) =>
      request<{ run: SkillRun }>(`/skills/${encodeURIComponent(id)}/run`, {
        method: "POST",
        body: JSON.stringify(args || {}),
      }),
    config: () => request<SkillsConfig>("/skills/config"),
    setConfig: (dir: string) =>
      request<SkillsConfig>("/skills/config", { method: "PUT", body: JSON.stringify({ dir }) }),
    runs: {
      list: (skillId?: string) =>
        request<{ items: SkillRun[] }>(
          `/skills/runs${skillId ? `?skillId=${encodeURIComponent(skillId)}` : ""}`
        ),
      get: (runId: string) =>
        request<{ run: SkillRun }>(`/skills/runs/${encodeURIComponent(runId)}`),
      cancel: (runId: string) =>
        request<{ ok: true }>(`/skills/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
        }),
    },
  },

  // Voice / assistant surface (Phase D). `ask` is callable from the first-party
  // web UI without an assistant token (loopback origin); the token routes manage
  // the scoped bearer tokens a Siri Shortcut carries.
  assistant: {
    ask: (
      text: string,
      opts?: {
        source?: AssistantSource;
        conversationId?: string;
        // Phase M: provider override + light client context (page, runId, hudMode).
        provider?: string;
        context?: Record<string, unknown>;
      }
    ) =>
      request<AssistantAskResponse>("/assistant/ask", {
        method: "POST",
        body: JSON.stringify({ text, ...(opts || {}) }),
      }),
    // Phase M confirm round-trip: execute one action after a tap (confirmToken)
    // or a retype (typedConfirm). Source is fixed to "chat" server-side.
    action: (args: {
      name: string;
      params?: Record<string, unknown>;
      confirmToken?: string;
      typedConfirm?: string;
    }) =>
      request<AssistantActionResult>("/assistant/action", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    // Phase Z: the latest browse frame, to hydrate the /browse view on mount
    // (frames stream during the action, before the popup deep-links the user in).
    browseLast: () => request<{ frame: BrowseFramePayload | null }>("/assistant/browse/last"),
    // Phase Z Tier 2: the latest computer-use frame, to hydrate /computer-use on mount.
    computerUseLast: () =>
      request<{ frame: ComputerUseFramePayload | null }>("/assistant/computer-use/last"),
    tokens: {
      list: () => request<{ tokens: AssistantToken[] }>("/assistant/tokens"),
      create: (label?: string) =>
        request<{ token: AssistantTokenCreated }>("/assistant/tokens", {
          method: "POST",
          body: JSON.stringify(label ? { label } : {}),
        }),
      revoke: (id: string) =>
        request<{ ok: true }>(`/assistant/tokens/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },
  },

  // Multi-provider AI harness (Phase E). Provider secrets stay server-side;
  // `config` returns a redacted view. Streaming turns go through
  // `streamChatMessage` (SSE), not `request`.
  chat: {
    providers: () => request<{ providers: ChatProviderStatus[] }>("/chat/providers"),
    config: () => request<{ config: ProvidersConfig }>("/chat/config"),
    updateConfig: (patch: Record<string, unknown>) =>
      request<{ config: ProvidersConfig }>("/chat/config", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    listChats: () => request<{ items: Chat[] }>("/chat/chats"),
    createChat: (args?: { title?: string; provider?: string; model?: string }) =>
      request<{ chat: Chat }>("/chat/chats", { method: "POST", body: JSON.stringify(args || {}) }),
    getChat: (id: string) =>
      request<{ chat: Chat; messages: ChatMessage[] }>(`/chat/chats/${encodeURIComponent(id)}`),
    renameChat: (id: string, title: string) =>
      request<{ chat: Chat }>(`/chat/chats/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    deleteChat: (id: string) =>
      request<{ ok: true }>(`/chat/chats/${encodeURIComponent(id)}`, { method: "DELETE" }),
    stream: streamChatMessage,
    // Upload one attachment (Phase Q1). FormData - request() forces JSON, so
    // this uses fetch directly like import.upload above.
    upload: async (file: File): Promise<{ attachment: ChatAttachment }> => {
      const form = new FormData();
      form.append("file", file);
      const token = dashboardToken();
      const res = await fetch(`${BASE}/chat/upload`, {
        method: "POST",
        headers: token ? { "x-dashboard-token": token } : undefined,
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      return body as { attachment: ChatAttachment };
    },
    linkPreview: (url: string) =>
      request<{ preview: LinkPreview }>(`/chat/link-preview?url=${encodeURIComponent(url)}`),
    generateImage: (id: string, prompt: string, model?: string) =>
      request<{ message: ChatMessage; url: string }>(
        `/chat/chats/${encodeURIComponent(id)}/image`,
        { method: "POST", body: JSON.stringify({ prompt, ...(model ? { model } : {}) }) }
      ),
  },

  alerts: {
    list: (params?: { unacked?: boolean; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.unacked) qs.set("unacked", "true");
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{
        alerts: AlertEvent[];
        total: number;
        unacked: number;
        limit: number;
        offset: number;
      }>(`/alerts${q ? `?${q}` : ""}`);
    },
    ack: (id: number) => request<{ alert: AlertEvent }>(`/alerts/${id}/ack`, { method: "POST" }),
    ackAll: () =>
      request<{ ok: true; acknowledged: number }>("/alerts/ack-all", { method: "POST" }),
    rules: {
      list: () => request<{ rules: AlertRule[] }>("/alerts/rules"),
      create: (rule: {
        name: string;
        rule_type: AlertRule["rule_type"];
        config: AlertRule["config"];
        enabled?: boolean;
        cooldown_seconds?: number;
      }) =>
        request<{ rule: AlertRule }>("/alerts/rules", {
          method: "POST",
          body: JSON.stringify(rule),
        }),
      update: (
        id: string,
        patch: Partial<Pick<AlertRule, "name" | "config" | "enabled" | "cooldown_seconds">>
      ) =>
        request<{ rule: AlertRule }>(`/alerts/rules/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      remove: (id: string) =>
        request<{ ok: true }>(`/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
  },

  webhooks: {
    list: () => request<{ targets: WebhookTarget[] }>("/webhooks"),
    providers: () => request<{ providers: WebhookProvider[] }>("/webhooks/providers"),
    create: (target: {
      name: string;
      type: WebhookType;
      url?: string;
      enabled?: boolean;
      secret?: string;
      headers?: Record<string, string>;
      config?: Record<string, string>;
      rule_ids?: string[];
    }) =>
      request<{ target: WebhookTarget }>("/webhooks", {
        method: "POST",
        body: JSON.stringify(target),
      }),
    update: (
      id: string,
      patch: {
        name?: string;
        url?: string;
        enabled?: boolean;
        secret?: string | null;
        headers?: Record<string, string>;
        config?: Record<string, string>;
        rule_ids?: string[];
      }
    ) =>
      request<{ target: WebhookTarget }>(`/webhooks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    test: (id: string) =>
      request<WebhookTestResult>(`/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" }),
    deliveries: (id: string, params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{ deliveries: WebhookDelivery[]; limit: number; offset: number }>(
        `/webhooks/${encodeURIComponent(id)}/deliveries${q ? `?${q}` : ""}`
      );
    },
  },

  // GitHub dev-workflow panel (Phase I). The PAT stays server-side; `config`
  // returns a redacted view (hasPat boolean). `overview` is the cached snapshot;
  // `refresh` forces a live poll.
  github: {
    overview: () => request<GitHubOverviewResponse>("/github"),
    refresh: () => request<GitHubOverviewResponse>("/github/refresh", { method: "POST" }),
    config: () => request<{ config: GitHubConfig }>("/github/config"),
    updateConfig: (patch: {
      enabled?: boolean;
      pat?: string;
      repos?: string[];
      pollMinutes?: number;
    }) =>
      request<{ config: GitHubConfig }>("/github/config", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
  },

  // Proactive Jarvis - briefings + nudges + persona toggle (Phase J).
  briefings: {
    list: (limit?: number) =>
      request<{
        items: Briefing[];
        latest: { morning: Briefing | null; evening: Briefing | null };
      }>(`/briefings${limit ? `?limit=${limit}` : ""}`),
    run: (kind: BriefingKind) =>
      request<{ briefing: Briefing }>("/briefings/run", {
        method: "POST",
        body: JSON.stringify({ kind }),
      }),
    config: () => request<{ config: ProactiveConfig }>("/briefings/config"),
    updateConfig: (patch: Partial<ProactiveConfig>) =>
      request<{ config: ProactiveConfig }>("/briefings/config", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
  },
};

function requestBackupsHelper(params?: { scope?: "user" | "project"; type?: CcArtifactType }) {
  const qs = new URLSearchParams();
  if (params?.scope) qs.set("scope", params.scope);
  if (params?.type) qs.set("type", params.type);
  const q = qs.toString();
  return request<{ items: CcBackup[] }>(`/cc-config/backups${q ? `?${q}` : ""}`);
}

export type CcArtifactType =
  | "skills"
  | "agents"
  | "commands"
  | "output-styles"
  | "memory"
  | "auto-memory";

export interface CcWriteArgs {
  // "auto-memory" targets a per-project memory file and requires `project`.
  scope: "user" | "project" | "auto-memory";
  type: CcArtifactType;
  name?: string;
  content: string;
  project?: string;
}

export interface CcDeleteArgs {
  scope: "user" | "project" | "auto-memory";
  type: CcArtifactType;
  name?: string;
  project?: string;
}

export interface CcMutationResult {
  ok: true;
  file: string;
  target: string;
  backupPath: string | null;
  created?: boolean;
}

export interface CcBackup {
  scope: "user" | "project" | "auto-memory";
  type: CcArtifactType;
  name: string;
  backupPath: string;
  isDir: boolean;
  mtime: number;
  size: number | null;
  project?: string; // present for scope === "auto-memory"
}

export type CcScope = "user" | "project" | "all";

export interface CcMdItem {
  scope: "user" | "project";
  name: string;
  file?: string;
  path?: string;
  size: number;
  mtime: number;
  truncated: boolean;
  frontmatter: Record<string, string>;
  preview: string;
}

export interface CcPluginContributions {
  skills: number;
  agents: number;
  commands: number;
  outputStyles: number;
  hooks: number;
  pluginJson: {
    name?: string;
    description?: string;
    version?: string;
    author?: { name?: string; email?: string };
    homepage?: string;
    repository?: string;
    license?: string;
    keywords?: string[];
  } | null;
}

export interface CcPlugin {
  key: string;
  name: string;
  marketplace: string | null;
  scope: string;
  version: string | null;
  installPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  gitCommitSha: string | null;
  installPathExists: boolean;
  enabled: boolean | null;
  contributes: CcPluginContributions | null;
}

export interface CcPluginsResponse {
  manifestPath: string;
  manifestExists: boolean;
  plugins: CcPlugin[];
}

export interface CcMcpServer {
  name: string;
  source: string;
  kind: "stdio" | "http" | "unknown";
  command?: string;
  args?: string[];
  envNames?: string[];
  url?: string;
  headers?: string[];
}

export interface CcMcpResponse {
  user: CcMcpServer[];
  projectScoped: CcMcpServer[];
}

export interface CcHookEntry {
  matcher: string;
  type: string;
  command: string | null;
  timeout: number | null;
}

export interface CcHookSource {
  scope: "user" | "project" | "project-local";
  file: string;
  exists: boolean;
  hooks: Record<string, CcHookEntry[]>;
}

export interface CcSettingsSource {
  scope: "user" | "project" | "project-local";
  file: string;
  exists: boolean;
  data?: unknown;
  raw_size?: number;
}

export interface CcMemoryItem {
  // "user"/"project" are the two CLAUDE.md files (editable). "auto-memory"
  // is a per-project file-based memory file under ~/.claude/projects/<slug>/
  // memory/ - read-only in the dashboard for now.
  scope: "user" | "project" | "auto-memory";
  file: string;
  size: number;
  mtime: number;
  truncated: boolean;
  preview: string;
  // Present only for scope === "auto-memory":
  project?: string; // the projects/<slug> dir name
  name?: string; // the markdown filename (e.g. MEMORY.md, feedback_x.md)
  isIndex?: boolean; // true for MEMORY.md / INDEX-*.md table-of-contents files
  frontmatter?: Record<string, string>; // parsed YAML frontmatter, if any
}

export interface CcFileResponse {
  ok: true;
  file: string;
  text: string;
  size: number;
  mtime: number;
  truncated: boolean;
}

export interface CcOverview {
  roots: {
    claudeHome: string;
    projectClaudeDir: string;
    projectRoot: string;
    claudeJson: string;
  };
  counts: {
    skills: { user: number; project: number };
    agents: { user: number; project: number };
    commands: { user: number; project: number };
    outputStyles: { user: number; project: number };
    plugins: number;
    pluginsEnabled: number;
    pluginsDisabled: number;
    marketplaces: number;
    keybindings: number;
    mcpServers: { user: number; project: number };
    hooks: Record<string, number>;
    memory: number;
    settingsFiles: number;
  };
}

export interface CcMarketplace {
  name: string;
  source: { source?: string; repo?: string; url?: string } | null;
  installLocation: string | null;
  lastUpdated: string | null;
  pluginCount: number | null;
  marketplaceName: string | null;
  marketplaceDescription: string | null;
  marketplaceOwner: { name?: string; url?: string } | null;
}

export interface CcMarketplacesResponse {
  knownPath: string;
  knownExists: boolean;
  items: CcMarketplace[];
}

export interface CcKeybindingGroup {
  context: string;
  bindings: { key: string; action: string }[];
}

export interface CcKeybindings {
  file: string;
  exists: boolean;
  schema?: string | null;
  docs?: string | null;
  groups: CcKeybindingGroup[];
}

export interface CcStatuslineScript {
  file: string;
  size: number;
  mtime: number;
  truncated: boolean;
  preview: string;
}

export interface CcStatusline {
  config: { type?: string; command?: string } | null;
  scripts: CcStatuslineScript[];
}

export interface CcHookScripts {
  dir: string;
  items: { name: string; file: string; size: number; mtime: number }[];
}

export type RunMode = "headless" | "conversation";
export type RunStatus = "spawning" | "running" | "completed" | "error" | "killed" | "abandoned";
export type PermissionMode = "acceptEdits" | "default" | "plan" | "bypassPermissions";
export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max";

export type PermissionUx = "auto" | "interactive";

export interface RunStartArgs {
  prompt: string;
  mode: RunMode;
  /** Agentic backend (Phase E). Defaults to "claude". */
  provider?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  permissionUx?: PermissionUx;
  resumeSessionId?: string;
  effort?: EffortLevel;
  /** Explicit Project override (Phase F). Omit to auto-match by cwd. */
  projectId?: string;
}

/** A spawnable agentic backend (Phase E, §E2). */
export interface AgentProviderInfo {
  id: string;
  label: string;
  supportsPermissionGate: boolean;
  supportsConversation: boolean;
  supportsResume: boolean;
}

export interface RunHandle {
  id: string;
  pid: number | null;
  provider?: string;
  mode: RunMode;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  permissionUx: PermissionUx;
  effort: EffortLevel | null;
  /** Project this run was tagged with (Phase F) - explicit or cwd-matched. */
  projectId?: string | null;
  prompt: string;
  argv: string[];
  resumeSessionId: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  sessionId: string | null;
  envelopeCount: number;
  /** Pending (unresolved) interactive permission requests as of the last
   *  fetch - lets the UI rebuild the panel on attach without waiting for a
   *  WS broadcast. Always `[]` for permissionUx:"auto" runs. */
  pendingPermissions: PermissionEntry[];
  stdoutTail: string;
  stderrTail: string;
  envelopes?: unknown[]; // present when fetched with ?envelopes=1
}

export interface RunListResponse {
  items: RunHandle[];
  maxConcurrent: number;
  activeCount: number;
}

/** Body for POST /api/schedules (Phase L). `targetOpts` captures the spawn
 *  options for a new_run, or `{ runId }` for a session_message follow-up. */
export interface ScheduleCreateArgs {
  label?: string | null;
  prompt: string;
  targetKind: ScheduleTargetKind;
  targetOpts?: {
    cwd?: string;
    model?: string;
    mode?: RunMode;
    permissionMode?: PermissionMode;
    permissionUx?: PermissionUx;
    effort?: EffortLevel;
    runId?: string;
  };
  triggerKind: ScheduleTriggerKind;
  /** ISO timestamp for triggerKind === "at". */
  fireAt?: string;
  /** Watched run id for triggerKind === "on_run_complete". */
  triggerRunId?: string;
  statusFilter?: ScheduleStatusFilter;
  chainDepth?: number;
}

/**
 * A row from the persistent `dashboard_runs` sqlite table - every run ever
 * spawned via /api/run, including completed / errored / killed ones long
 * after the in-memory handle has been reaped.
 */
export interface DashboardRunHistoryItem {
  id: string;
  session_id: string | null;
  mode: RunMode;
  cwd: string;
  model: string | null;
  permission_mode: PermissionMode | null;
  effort: EffortLevel | null;
  resume_session_id: string | null;
  prompt_preview: string | null;
  status: RunStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  isLive: boolean;
  project_id: string | null;
}

export interface CwdSuggestion {
  kind: "dashboard" | "home" | "recent";
  path: string;
  label: string;
}

// ── Voice / assistant (Phase D) ──
export type AssistantSource = "siri" | "carplay" | "chat" | "notes" | "quickaction";
export type AssistantIntent = "status" | "kill" | "steer" | "note" | "run_skill" | "chat" | "empty";

/** Outcome of one assistant action through the risk gate (Phase M, §3.1). */
export type AssistantActionStatus = "done" | "needs_confirm" | "denied" | "error";

export interface AssistantAction {
  name: string;
  params?: Record<string, unknown>;
  status: AssistantActionStatus;
  /** Present on `needs_confirm` for a `confirm`-risk action - re-send to execute. */
  confirmToken?: string;
  /** Present on `needs_confirm` for a `typed`-risk action - user must retype name. */
  requiresTyped?: boolean;
  side?: "server" | "client";
  result?: Record<string, unknown>;
  error?: string;
  reason?: string;
}

/** Full dispatcher output from POST /assistant/action (the confirm round-trip). */
export interface AssistantActionResult extends AssistantAction {
  risk?: "safe" | "confirm" | "typed";
}

export interface AssistantAskResponse {
  text: string;
  /** Short, markdown-free, number-rounded variant Siri reads aloud. */
  speech: string;
  intent: AssistantIntent;
  source: AssistantSource;
  conversationId: string | null;
  provider?: string;
  taskClass?: "simple" | "standard" | "complex";
  data?: Record<string, unknown>;
  /** Actions the model/loop produced for the client to render/execute (Phase M). */
  actions?: AssistantAction[];
  /** Present only when `requestedProvider` failed and the tiered router answered instead. */
  requestedProvider?: string;
  /** The requested provider's error message, when a fallback occurred. */
  providerError?: string;
}

/** A stored assistant token - never carries the secret (only a hash is persisted). */
export interface AssistantToken {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The create response - `token` (plaintext) is present exactly once. */
export interface AssistantTokenCreated extends AssistantToken {
  token: string;
}

export interface ModelChoice {
  id: string; // value sent to claude --model
  label: string; // user-facing
  hint?: string;
}

// Effort level choices for `claude --effort`. Higher = more thinking tokens
// before the assistant turn. Empty inherits the model's default.
export interface EffortChoice {
  id: EffortLevel;
  label: string;
  hint?: string;
}

export const RUN_EFFORT_CHOICES: EffortChoice[] = [
  { id: "", label: "Default (model decides)", hint: "No --effort flag" },
  { id: "low", label: "Low", hint: "Fast, minimal thinking" },
  { id: "medium", label: "Medium", hint: "Balanced" },
  { id: "high", label: "High", hint: "More reasoning, slower" },
  { id: "xhigh", label: "Extra-high", hint: "Deep reasoning" },
  { id: "max", label: "Max", hint: "All-out - slowest, most tokens" },
];

// Curated model list. "" means "inherit from settings.json" - no --model flag.
export const RUN_MODEL_CHOICES: ModelChoice[] = [
  { id: "", label: "Inherit from settings", hint: "Use whatever your settings.json model is" },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 (1M context)",
    hint: "Highest capability, 1M token window",
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 (1M context)",
    hint: "Previous Opus, 1M token window",
  },
  { id: "sonnet", label: "Sonnet 4.6", hint: "Balanced capability and speed" },
  { id: "haiku", label: "Haiku 4.5", hint: "Fastest, lightest" },
];

export interface ImportResult {
  ok: boolean;
  source: "default" | "path" | "upload";
  path?: string;
  imported: number;
  skipped: number;
  backfilled?: number;
  errors: number;
  sessions_seen?: number;
  files_scanned?: number;
  files_received?: number;
  entries_extracted?: number;
  entries_skipped?: number;
}
