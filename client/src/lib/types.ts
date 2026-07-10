/**
 * @file types.ts
 * @description Defines TypeScript types and interfaces for the agent dashboard application, including data structures for sessions, agents, events, statistics, analytics, model pricing, cost breakdowns, WebSocket messages, and workflow-related data. These types provide a clear contract for the shape of data used throughout the application and facilitate type safety when interacting with the backend API and managing state within the frontend components.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

export type SessionStatus = "active" | "completed" | "error" | "abandoned";
export type AgentStatus = "working" | "waiting" | "completed" | "error";
export type AgentType = "main" | "subagent";

/**
 * UI-only status that overlays the persisted SessionStatus/AgentStatus when
 * `awaiting_input_since` is set on a session or agent. Renders as a yellow
 * "Waiting" badge so the dashboard can flag sessions blocked on a Claude Code
 * permission prompt without changing the underlying lifecycle enum.
 */
export const AWAITING_STATUS = "waiting" as const;
export type EffectiveAgentStatus = AgentStatus | typeof AWAITING_STATUS;
export type EffectiveSessionStatus = SessionStatus | typeof AWAITING_STATUS;

export interface Session {
  id: string;
  name: string | null;
  status: SessionStatus;
  cwd: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  metadata: string | null;
  agent_count?: number;
  last_activity?: string;
  cost?: number;
  /** ISO timestamp set when Claude Code is blocked waiting for the user
   * (permission prompt or "waiting for your input" notice). Cleared on the
   * next non-Notification hook event. Null when the session is not waiting. */
  awaiting_input_since?: string | null;
  /** Project this session auto-associated with by cwd (Phase F). */
  project_id?: string | null;
}

export interface Agent {
  id: string;
  session_id: string;
  name: string;
  type: AgentType;
  subagent_type: string | null;
  status: AgentStatus;
  task: string | null;
  current_tool: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
  parent_agent_id: string | null;
  metadata: string | null;
  /** Mirrors the parent session: ISO timestamp when set, null otherwise. */
  awaiting_input_since?: string | null;
  /**
   * The agent's OWN cost (USD), computed server-side from its per-agent token
   * buckets. Present for subagents that carry usage in their metadata; 0/absent
   * for main agents (whose cost is the session total) and compaction agents.
   */
  cost?: number;
}

/** True when a session is paused on a permission prompt or input request. */
export function isSessionAwaitingInput(session: Session | undefined | null): boolean {
  return !!session?.awaiting_input_since && session.status === "active";
}

/** True when an agent is the one blocked on user input (typically a main agent). */
export function isAgentAwaitingInput(agent: Agent | undefined | null): boolean {
  if (!agent?.awaiting_input_since) return false;
  // Once the agent's lifecycle has ended, the waiting flag is stale; ignore it.
  return agent.status !== "completed" && agent.status !== "error";
}

export function effectiveAgentStatus(agent: Agent): EffectiveAgentStatus {
  return isAgentAwaitingInput(agent) ? AWAITING_STATUS : agent.status;
}

export function effectiveSessionStatus(session: Session): EffectiveSessionStatus {
  return isSessionAwaitingInput(session) ? AWAITING_STATUS : session.status;
}

export interface DashboardEvent {
  id: number;
  session_id: string;
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  data: string | null;
  created_at: string;
}

export interface Stats {
  total_sessions: number;
  active_sessions: number;
  active_agents: number;
  total_agents: number;
  total_events: number;
  events_today: number;
  ws_connections: number;
  agents_by_status: Record<string, number>;
  sessions_by_status: Record<string, number>;
  session_window: SessionWindow;
}

/**
 * The Claude subscription's rolling 5-hour usage window. `source: "real"`
 * means this came straight from Anthropic's API via the dashboard's
 * usage-poller (server/lib/usage-poller.js) - genuinely accurate, not a
 * guess. `source: "estimated"` is the local fallback: reconstructed purely
 * from event timestamps already in the DB (no API calls) for when the real
 * poller has no reading yet, or is disabled (DISABLE_USAGE_PROBE=1). `active`
 * is false when the window has expired with no newer activity - a fresh
 * window opens on next use. `status`/`isUsingOverage` are real-poll-only
 * (Anthropic's own allowed/rejected verdict); null under "estimated".
 *
 * Phase P: the real reading is now captured ORGANICALLY off the user's own
 * Claude runs/chats/brain calls (zero extra tokens), with the probe demoted
 * to a gated fallback. `sampleSource` says which produced it; `sampleAgeMs`
 * is its age. The countdown clock always ticks live off the exact `resetsAt`
 * regardless of sample age; only `percentUsed` is dimmed when stale.
 * `percentUsed` is null until the envelope's utilization field is confirmed.
 */
export interface SessionWindow {
  active: boolean;
  startedAt: string | null;
  resetsAt: string | null;
  eventsInWindow: number;
  source: "real" | "estimated";
  status: "allowed" | "rejected" | string | null;
  isUsingOverage: boolean | null;
  /** Age of the underlying real reading in ms; null under "estimated". */
  probeAgeMs: number | null;
  /** Percent of the window used (0-100) if the envelope carries it; else null. */
  percentUsed: number | null;
  /** Age of the underlying real sample in ms; null under "heuristic". */
  sampleAgeMs: number | null;
  /** Which producer supplied the reading. */
  sampleSource: "organic" | "probe" | "heuristic";
}

export interface Analytics {
  tokens: {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_write: number;
  };
  tool_usage: Array<{ tool_name: string; count: number }>;
  daily_events: Array<{ date: string; count: number }>;
  daily_sessions: Array<{ date: string; count: number }>;
  agent_types: Array<{ subagent_type: string; count: number }>;
  event_types: Array<{ event_type: string; count: number }>;
  avg_events_per_session: number;
  total_subagents: number;
  overview: {
    total_sessions: number;
    active_sessions: number;
    active_agents: number;
    total_agents: number;
    total_events: number;
  };
  agents_by_status: Record<string, number>;
  sessions_by_status: Record<string, number>;
}

export interface ModelPricing {
  model_pattern: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  cache_write_1h_per_mtok: number;
  fast_input_per_mtok: number;
  fast_output_per_mtok: number;
  // Time-limited introductory rates: usage on/before intro_until (YYYY-MM-DD)
  // prices at these rates, after it at the standard rates. null/0 = no intro.
  intro_input_per_mtok?: number;
  intro_output_per_mtok?: number;
  intro_cache_read_per_mtok?: number;
  intro_cache_write_per_mtok?: number;
  intro_cache_write_1h_per_mtok?: number;
  intro_until?: string | null;
  updated_at: string;
}

export interface CostBreakdown {
  model: string;
  speed?: string;
  inference_geo?: string;
  service_tier?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens?: number;
  web_search_requests?: number;
  web_fetch_requests?: number;
  code_execution_requests?: number;
  cost: number;
  matched_rule: string | null;
}

export interface CostFeatureCosts {
  web_search_cost: number;
  web_fetch_cost: number;
  code_execution_cost: number;
  code_execution_hours_estimated: number;
  code_execution_free_hours: number;
}

export interface UnpricedModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostResult {
  total_cost: number;
  breakdown: CostBreakdown[];
  daily_costs: Array<{ date: string; cost: number }>;
  feature_costs?: CostFeatureCosts;
  unpriced_models?: UnpricedModel[];
}

export interface ImportProgressMessage {
  importId?: string;
  phase: "start" | "scan" | "extract" | "parse" | "complete" | "error" | "extract_error";
  source?: "default" | "path" | "upload";
  processed?: number;
  total?: number;
  current?: string;
  path?: string;
  error?: string;
  counters?: Record<string, number>;
}

/** Payload for `update_status` WebSocket messages and GET /api/updates/status */
export interface UpdateStatusPayload {
  git_repo: boolean;
  update_available: boolean;
  repo_root?: string;
  remote_ref?: string | null;
  /** Remote name we compared against - "upstream" if configured (fork
   * convention), else "origin", else whatever single remote is set up. */
  canonical_remote?: string | null;
  /** Local branch HEAD points at. null on detached HEAD. */
  current_branch?: string | null;
  /** What the local branch tracks (e.g. "origin/feature/foo"). null when
   * no upstream is configured for the current branch. */
  tracking_upstream?: string | null;
  /** True when the local branch's tracked upstream is exactly remote_ref
   * - i.e. a plain `git pull --ff-only` will do the right thing. */
  tracks_canonical?: boolean;
  /** Categorical hint for the UI. Discriminated so callers can branch on
   * shape (e.g. show "Restart after running" only when the command
   * actually rewrites the working tree). */
  situation?:
    | "tracking_canonical"
    | "fork_or_diverged_tracking"
    | "feature_branch"
    | "detached_head";
  /** Plain-language explanation when the user is *not* on the canonical
   * default branch, so the manual command makes sense in context. */
  situation_note?: string | null;
  local_sha?: string | null;
  remote_sha?: string | null;
  commits_behind?: number;
  manual_command?: string | null;
  message?: string | null;
  fetch_error?: string;
}

export interface RunStreamPayload {
  id: string;
  envelope: unknown;
}
export interface RunStatusPayload {
  id: string;
  status: "spawning" | "running" | "completed" | "error" | "killed";
  at: number;
  exitCode?: number;
  sessionId?: string | null;
  error?: string;
}
export interface RunInputAckPayload {
  id: string;
  messageId: string;
  at: number;
}

// ── Interactive permission gate (Run page) ──────────────────────────────

export type PermissionDecision = "allow" | "deny";

/** One PreToolUse gate request, serialised by server/lib/run-spawner.js's
 *  `publicPermission`. `toolInput` mirrors the tool_use block's `input`. */
export interface PermissionEntry {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  status: "pending" | "resolved";
  decision: PermissionDecision | null;
  reason: string | null;
  openedAt: number;
  resolvedAt: number | null;
}

export interface PermissionRequestPayload {
  id: string;
  request: PermissionEntry;
}

// ── Multi-account tracking (Phase K) ─────────────────────────────────────
// The dashboard OBSERVES claude-swap (read-only) and presents both Claude
// accounts as one unified view. Everything is empty/absent for single-account
// (non-swap) setups, so the UI hides its multi-account chrome when `present`
// is false.

export interface Account {
  id: string;
  label: string | null;
  active: number; // 1 when this is the account currently in use
  first_seen: string;
  last_active: string | null;
  /** Best-effort per-account window reset (ISO); often null for the inactive one. */
  resets_at: string | null;
  metadata: string | null;
}

export interface AccountSwap {
  id: number;
  from_account: string | null;
  to_account: string;
  reason: string | null;
  created_at: string;
}

export interface AccountsState {
  /** False when claude-swap isn't detected - a single implicit account. */
  present: boolean;
  activeAccountId: string | null;
  accounts: Account[];
  swaps: AccountSwap[];
}

/** `account_swapped` WS payload (server/lib/claude-swap.js). */
export interface AccountSwappedPayload {
  from: string | null;
  to: string;
  reason: string | null;
  at: string;
}

// ── Scheduled & chained prompts (Phase L) ────────────────────────────────

export type ScheduleStatus = "pending" | "fired" | "cancelled" | "failed";
export type ScheduleTargetKind = "new_run" | "session_message";
export type ScheduleTriggerKind = "at" | "on_run_complete";
export type ScheduleStatusFilter = "any" | "success";

export interface ScheduledPrompt {
  id: string;
  label: string | null;
  prompt: string;
  target_kind: ScheduleTargetKind;
  /** JSON string of the captured spawn opts (new_run) or { runId } (session_message). */
  target_opts: string;
  trigger_kind: ScheduleTriggerKind;
  fire_at: string | null;
  trigger_run_id: string | null;
  status_filter: ScheduleStatusFilter;
  status: ScheduleStatus;
  chain_depth: number;
  late: number;
  fired_at: string | null;
  result_run_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Proactive Jarvis: briefings + nudges (Phase J) ─────────────────────────

export type BriefingKind = "morning" | "evening";

export interface Briefing {
  id: string;
  kind: BriefingKind;
  /** schedule | manual | voice */
  trigger: string | null;
  text: string;
  speech: string | null;
  /** brain provider that composed it, or null for the deterministic fallback. */
  provider: string | null;
  note_id: string | null;
  /** persona variant that voiced it ("jarvis" | "ultron"), null if persona off. */
  persona?: string | null;
  created_at: string;
}

export interface BriefingScheduleConfig {
  enabled: boolean;
  /** "HH:MM" 24h local time. */
  time: string;
}

export interface NudgesConfig {
  runFailed: boolean;
  waitingAgents: boolean;
  waitingMinutes: number;
}

export interface ProactiveConfig {
  morning: BriefingScheduleConfig;
  evening: BriefingScheduleConfig;
  nudges: NudgesConfig;
  /** JARVIS personality toggle (affects assistant/briefing voice + nudge copy). */
  persona: boolean;
}

// ── Projects (Phase F) ───────────────────────────────────────────────────
// The dashboard-native organizing dimension over sessions/runs/chats.
// Deliberately separate from Claude.ai's own "Projects" feature.

export type ProjectStatus = "active" | "paused" | "done";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  repo_path: string | null;
  notes_dir: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectPath {
  id: string;
  project_id: string;
  repo_path: string;
  created_at: string;
}

export interface ProjectRollup {
  sessionCount: number;
  runCount: number;
  chatCount: number;
  noteCount: number;
  recentSessions: Session[];
  recentRuns: DashboardRunHistoryItemLite[];
  recentChats: Chat[];
  recentNotes: NoteMeta[];
  lastActivityAt: string | null;
}

/** Minimal shape of a `dashboard_runs` row as returned by the Projects
 *  rollup endpoints (a plain persisted row, not a live run.js RunHandle). */
export interface DashboardRunHistoryItemLite {
  id: string;
  session_id: string | null;
  mode: string;
  cwd: string;
  model: string | null;
  status: string;
  prompt_preview: string | null;
  started_at: string;
  ended_at: string | null;
}

/** A Project card with its list-view rollup (GET /api/projects). */
export interface ProjectWithRollup extends Project {
  rollup: ProjectRollup;
}

// ── Notes + mini-Jarvis brain (Phase G) ────────────────────────────────────

export type NoteSource = "manual" | "dump" | "voice";

/** A note's index metadata (list/search rows - no body). */
export interface NoteMeta {
  id: string;
  path: string;
  title: string;
  tags: string[];
  projectId: string | null;
  source: NoteSource | string;
  excerpt: string;
  mtime: string;
  createdAt: string;
  updatedAt: string;
}

/** A full note (metadata + markdown body). */
export interface Note extends NoteMeta {
  body: string;
}

export interface NoteTag {
  tag: string;
  count: number;
}

// ── Knowledge vault (Phase S) ────────────────────────────────────────────────

/** One node of the vault graph (a markdown file in the vault tree). */
export interface VaultNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  projectId: string | null;
  updatedAt: string;
}

export interface VaultEdge {
  src: string;
  dst: string;
  type: string;
}

export interface VaultGraph {
  nodes: VaultNode[];
  edges: VaultEdge[];
}

/** An outgoing link from a node ([[wikilink]] or frontmatter relation). */
export interface VaultLink {
  key: string;
  type: string;
  id: string | null;
  title: string | null;
  resolved: boolean;
}

export interface VaultBacklink {
  id: string;
  title: string;
  type: string;
}

/** Full node detail: the note plus its neighborhood. */
export interface VaultNodeDetail extends Note {
  nodeType: string;
  outgoing: VaultLink[];
  backlinks: VaultBacklink[];
}

export interface VaultPathStep {
  id: string;
  title: string;
  type: string;
}

// ── Vault entity engine + graphify bridge (Phase T) ─────────────────────────

/** GET /api/vault/engine/status */
export interface VaultEngineStatus {
  running: boolean;
  lastRun: string | null;
  totalEntities: number;
  promotedEntities: number;
}

/** POST /api/vault/engine/run result (also the `done` WS payload fields). */
export interface VaultEngineResult {
  notesScanned: number;
  entitiesSeen: number;
  entitiesCreated: number;
  notesLinked: number;
  errors: number;
}

/** `vault_engine` WS event: live progress for the brain animation. */
export interface VaultEnginePayload extends Partial<VaultEngineResult> {
  phase: "start" | "scan" | "entities" | "promoted" | "linked" | "done";
  total?: number;
  noteId?: string;
  title?: string;
  type?: string;
  names?: string[];
  titles?: string[];
}

/** GET /api/vault/graphify/status */
export interface VaultGraphifyStatus {
  running: string[];
  projects: Record<
    string,
    { lastRun?: string; ok?: boolean; error?: string | null; nodes?: number; edges?: number }
  >;
}

/** `vault_graphify` WS event. */
export interface VaultGraphifyPayload {
  phase: "start" | "extract" | "label" | "export" | "done" | "error";
  projectId: string;
  name?: string;
  message?: string;
  nodes?: number;
  edges?: number;
}

export interface NotesConfig {
  dir: string;
  default: string;
}

/** Result of POST /api/notes/dump (brain-dump reformatting). */
export interface DumpResult {
  raw: string;
  formatted: boolean;
  provider: string | null;
  title: string;
  body: string;
  tags: string[];
  todos: string[];
  note?: Note;
}

/** A pending voice/chat "note: …" capture awaiting filing. */
export interface NoteCapture {
  id: string;
  text: string;
  source: string | null;
  status: string;
  created_at: string;
}

// ── Skills (Phase H) ─────────────────────────────────────────────────────
// Skill definitions are markdown files on disk (same file-first philosophy as
// notes); this is the parsed shape GET /api/skills returns. Execution history
// (SkillRun) is the only part that lives in SQLite.

export type SkillStepType = "shell" | "agent" | "brain" | "notify" | "phone";
export type SkillConfirmLevel = "none" | "tap" | "typed";

/** One step's frontmatter - shape varies by `type`; fields not used by a given
 *  type are simply absent. Kept loose (not a discriminated union) since the
 *  parser on the server is a generic YAML-subset reader, not a strict schema. */
export interface SkillStep {
  type: SkillStepType;
  label?: string;
  // shell
  command?: string;
  cwd?: string;
  timeout?: number;
  // agent
  prompt?: string;
  provider?: string;
  permissionUx?: string;
  wait?: boolean;
  // brain
  taskClass?: "simple" | "standard" | "complex";
  // notify
  message?: string;
  title?: string;
  category?: string;
  // phone
  shortcut?: string;
  name?: string;
}

export interface SkillParam {
  name: string;
  type?: string;
  label?: string;
  default?: string | number | boolean;
  required?: boolean;
}

/** A parsed skill definition (GET /api/skills, GET /api/skills/:id). */
export interface Skill {
  id: string;
  path: string;
  name: string;
  icon: string | null;
  description: string;
  confirm: SkillConfirmLevel;
  schedule: string | null;
  params: SkillParam[];
  steps: SkillStep[];
  valid: boolean;
  errors: string[];
  /** Present only on GET /api/skills/:id - the raw markdown+frontmatter file. */
  raw?: string;
}

export type SkillRunTrigger = "manual" | "voice" | "phone" | "schedule";
export type SkillRunStatus = "running" | "success" | "failed" | "cancelled";
export type SkillStepStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export interface SkillRunStep {
  index: number;
  type: SkillStepType;
  label: string;
  status: SkillStepStatus;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One skill execution (GET /api/skills/runs, GET /api/skills/runs/:id). */
export interface SkillRun {
  id: string;
  skill_id: string;
  skill_name: string;
  trigger: SkillRunTrigger;
  status: SkillRunStatus;
  params: Record<string, unknown>;
  steps: SkillRunStep[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SkillsConfig {
  dir: string;
  default: string;
}

export type PulseState = "active" | "neglected" | "idle" | "paused" | "completed";

/** One project's pulse (working/neglected/completed tracker). */
export interface ProjectPulse {
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  state: PulseState | string;
  summary: string;
  daysSinceActivity: number | null;
  openTodos: number;
  lastActivityAt: string | null;
  computedAt: string;
}

/** Pulse as stored on a single project (GET /api/projects/:id). */
export interface ProjectPulseRow {
  project_id: string;
  state: string;
  summary: string;
  days_since_activity: number | null;
  open_todos: number;
  last_activity_at: string | null;
  computed_at: string;
}

export interface CcConfigChangedPayload {
  source: "dashboard" | "fs";
  action?: "write" | "delete";
  scope?: "user" | "project";
  type?: string;
  name?: string | null;
  paths?: string[];
}

// ── Alerting ──

export type AlertRuleType = "event_pattern" | "inactivity" | "status_duration" | "token_threshold";

export interface AlertRuleConfig {
  event_type?: string;
  tool_name?: string;
  summary_contains?: string;
  count?: number;
  window_minutes?: number;
  minutes?: number;
  status?: "working" | "waiting";
  total_tokens?: number;
}

export interface AlertRule {
  id: string;
  name: string;
  rule_type: AlertRuleType;
  config: AlertRuleConfig;
  enabled: boolean;
  cooldown_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface AlertEvent {
  id: number;
  rule_id: string;
  rule_name: string;
  rule_type: AlertRuleType;
  session_id: string | null;
  agent_id: string | null;
  message: string;
  details: string | null;
  triggered_at: string;
  acknowledged_at: string | null;
}

// ── Webhooks ──

export type WebhookType =
  | "slack"
  | "discord"
  | "teams"
  | "google_chat"
  | "mattermost"
  | "rocketchat"
  | "telegram"
  | "pagerduty"
  | "opsgenie"
  | "splunk_oncall"
  | "zapier"
  | "make"
  | "n8n"
  | "pipedream"
  | "generic";

export interface WebhookProviderField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  type: "string" | "enum";
  options: string[] | null;
  default: string | null;
}

export interface WebhookProvider {
  type: WebhookType;
  label: string;
  family: "chat" | "api" | "generic";
  url_required: boolean;
  has_default_url: boolean;
  derives_url: boolean;
  allow_http: boolean;
  url_hint: string | null;
  supports_secret: boolean;
  supports_headers: boolean;
  fields: WebhookProviderField[];
}

export interface WebhookDeliverySummary {
  status: "success" | "failed";
  status_code: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
}

export interface WebhookTarget {
  id: string;
  name: string;
  type: WebhookType;
  enabled: boolean;
  /** Masked: host + last 4 chars. The full URL is never returned by the API. */
  url_preview: string;
  has_secret: boolean;
  /** Generic targets only; values are masked ("••••"). */
  headers: Record<string, string> | null;
  /** Provider config (Telegram chat_id, PagerDuty routing_key, …); secret values masked. */
  config: Record<string, string> | null;
  /** Rule ids this target is scoped to; null = all rules. */
  rule_ids: string[] | null;
  created_at: string;
  updated_at: string;
  last_delivery: WebhookDeliverySummary | null;
}

export interface WebhookDelivery {
  id: number;
  target_id: string;
  target_name: string;
  target_type: WebhookType;
  alert_id: number | null;
  status: "success" | "failed";
  status_code: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
}

export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  error: string | null;
}

// ── Subscriptions / finance tracker (Phase AE) ──────────────────────────────

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  currency: string;
  cadence: "monthly" | "yearly" | "custom";
  cadence_days: number | null;
  next_renewal: string | null;
  category: string | null;
  notes: string | null;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionCandidate {
  name: string;
  amount: number;
  currency: string;
  cadence: "monthly" | "yearly" | "custom";
  cadence_days: number | null;
  category: string | null;
}

export interface SubscriptionSummary {
  active_count: number;
  by_currency: Record<string, { monthly_burn: number; yearly_projection: number; count: number }>;
  upcoming: (Subscription & { days_until: number })[];
  next_renewal: {
    id: string;
    name: string;
    amount: number;
    currency: string;
    date: string;
    days_until: number;
  } | null;
}

export interface WSMessage {
  type:
    | "session_created"
    | "session_updated"
    | "agent_created"
    | "agent_updated"
    | "new_event"
    | "import.progress"
    | "update_status"
    | "run_stream"
    | "run_status"
    | "run_input_ack"
    | "permission_request"
    | "permission_resolved"
    | "cc_config_changed"
    | "alert_triggered"
    | "alert_updated"
    | "workflow_upserted"
    | "account_swapped"
    | "schedule_created"
    | "schedule_updated"
    | "schedule_cancelled"
    | "schedule_fired"
    | "schedule_failed"
    | "note_changed"
    | "vault_engine"
    | "vault_graphify"
    | "skill_run_started"
    | "skill_run_step"
    | "skill_run_finished"
    | "skill_run_failed"
    | "skill_changed"
    | "github_updated"
    | "monday_updated"
    | "briefing_created"
    | "subscriptions_updated"
    | "browse_frame"
    | "computer_use_frame"
    | "notification_created"
    | "notification_read";
  data:
    | Session
    | Agent
    | DashboardEvent
    | ImportProgressMessage
    | UpdateStatusPayload
    | RunStreamPayload
    | RunStatusPayload
    | RunInputAckPayload
    | PermissionRequestPayload
    | CcConfigChangedPayload
    | AlertEvent
    | WorkflowRun
    | AccountSwappedPayload
    | ScheduledPrompt
    | SkillRun
    | GitHubOverview
    | MondayOverview
    | Briefing
    | BrowseFramePayload
    | ComputerUseFramePayload
    | AppNotification
    | NotificationReadPayload
    | VaultEnginePayload
    | VaultGraphifyPayload
    | { at: string };
  timestamp: string;
}

// ── Notification inbox (Phase O) ──
export interface AppNotification {
  id: string;
  category: string | null;
  title: string;
  body: string | null;
  /** Deep link + entity ids ({url, runId, sessionId, …}). */
  data: Record<string, unknown>;
  source: string | null;
  dedupe_key: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationReadPayload {
  ids?: string[];
  all?: boolean;
}

// ── Live browser view (Phase Z, Tier 1) ──
export interface BrowseFramePayload {
  url: string;
  title: string;
  image: string; // data:image/jpeg;base64,...
  note: string | null;
  at: string;
}

// ── Live computer-use view (Phase Z, Tier 2 - the real desktop) ──
export interface ComputerUseFramePayload {
  image: string; // data:image/jpeg;base64,...
  note: string | null;
  at: string;
}

// ── GitHub dev-workflow panel (Phase I) ──

export type GitHubCi = "success" | "failure" | "pending" | "none" | "unknown";
export type GitHubMode = "gh" | "pat" | "none";

export interface GitHubPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string | null;
  isDraft: boolean;
  reviewDecision: string | null;
  ci: GitHubCi;
}

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string | null;
}

export interface GitHubLatestCommit {
  repo: string;
  branch: string;
  message: string;
  isMerge: boolean;
  mergedPr: { number: number; fromRef: string; title: string | null } | null;
  author: string | null;
  date: string | null;
  url: string | null;
}

export interface GitHubOverview {
  configured: boolean;
  mode: GitHubMode;
  me: string | null;
  repos: string[];
  counts: {
    reviewRequested: number;
    mine: number;
    failingChecks: number;
    openIssues: number;
  };
  reviewRequested: GitHubPr[];
  mine: GitHubPr[];
  issues: GitHubIssue[];
  latest: GitHubLatestCommit[];
  error: string | null;
}

export interface GitHubOverviewResponse {
  overview: GitHubOverview;
  fetchedAt: string | null;
  error: string | null;
  mode: GitHubMode;
  configured: boolean;
}

export interface GitHubConfig {
  enabled: boolean;
  hasPat: boolean;
  repos: string[];
  pollMinutes: number;
}

// ── Monday.com panel (Phase AD) ──

export interface MondayItem {
  id: string;
  boardId: string;
  boardName: string;
  group: string | null;
  name: string;
  url: string | null;
  updatedAt: string | null;
  dueDate: string | null; // YYYY-MM-DD
  status: string | null;
  statusColumnId: string | null;
  mine: boolean;
  done: boolean;
}

export interface MondayBoard {
  id: string;
  name: string;
  url: string | null;
  itemCount: number;
}

export interface MondayOverview {
  configured: boolean;
  me: { id: string; name: string | null } | null;
  boards: MondayBoard[];
  mine: MondayItem[];
  dueToday: MondayItem[];
  overdue: MondayItem[];
  recent: MondayItem[];
  counts: { mine: number; dueToday: number; overdue: number; boards: number };
  error: string | null;
}

export interface MondayOverviewResponse {
  overview: MondayOverview;
  fetchedAt: string | null;
  error: string | null;
  configured: boolean;
}

export interface MondayConfig {
  enabled: boolean;
  hasToken: boolean;
  pollMinutes: number;
  doneLabel: string;
}

// ── Session stats ──

export interface SessionStats {
  session_id: string;
  total_events: number;
  events_by_type: Array<{ event_type: string; count: number }>;
  tools_used: Array<{ tool_name: string; count: number }>;
  error_count: number;
  first_event_at: string | null;
  last_event_at: string | null;
  agents: {
    total: number;
    main: number;
    subagent: number;
    compaction: number;
    by_status: Record<string, number>;
  };
  subagent_types: Array<{ subagent_type: string; count: number }>;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
}

// ── Workflow types ──

export interface WorkflowStats {
  totalSessions: number;
  totalAgents: number;
  totalSubagents: number;
  avgSubagents: number;
  successRate: number;
  avgDepth: number;
  avgDurationSec: number;
  totalCompactions: number;
  avgCompactions: number;
  topFlow: { source: string; target: string; count: number } | null;
}

export interface OrchestrationEdge {
  source: string;
  target: string;
  weight: number;
}

export interface OrchestrationData {
  sessionCount: number;
  mainCount: number;
  subagentTypes: Array<{ subagent_type: string; count: number; completed: number; errors: number }>;
  edges: OrchestrationEdge[];
  outcomes: Array<{ status: string; count: number }>;
  compactions: { total: number; sessions: number };
}

export interface ToolFlowTransition {
  source: string;
  target: string;
  value: number;
}

export interface ToolFlowData {
  transitions: ToolFlowTransition[];
  toolCounts: Array<{ tool_name: string; count: number }>;
}

export interface SubagentEffectivenessItem {
  subagent_type: string;
  total: number;
  completed: number;
  errors: number;
  sessions: number;
  successRate: number;
  avgDuration: number | null;
  trend: number[];
}

export interface WorkflowPattern {
  steps: string[];
  count: number;
  percentage: number;
}

export interface WorkflowPatternsData {
  patterns: WorkflowPattern[];
  soloSessionCount: number;
  soloPercentage: number;
}

export interface ModelDelegationData {
  mainModels: Array<{ model: string; agent_count: number; session_count: number }>;
  subagentModels: Array<{ model: string; agent_count: number }>;
  tokensByModel: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>;
}

export interface ErrorPropagationData {
  byDepth: Array<{ depth: number; count: number }>;
  byType: Array<{ subagent_type: string; count: number }>;
  eventErrors: Array<{ summary: string; count: number }>;
  sessionsWithErrors: number;
  totalSessions: number;
  errorRate: number;
}

export interface ConcurrencyLane {
  name: string;
  avgStart: number;
  avgEnd: number;
  count: number;
}

export interface ConcurrencyData {
  aggregateLanes: ConcurrencyLane[];
}

export interface SessionComplexityItem {
  id: string;
  name: string | null;
  status: string;
  duration: number;
  agentCount: number;
  subagentCount: number;
  totalTokens: number;
  model: string | null;
}

export interface CompactionImpactData {
  totalCompactions: number;
  tokensRecovered: number;
  perSession: Array<{ session_id: string; compactions: number }>;
  sessionsWithCompactions: number;
  totalSessions: number;
}

export interface WorkflowData {
  stats: WorkflowStats;
  orchestration: OrchestrationData;
  toolFlow: ToolFlowData;
  effectiveness: SubagentEffectivenessItem[];
  patterns: WorkflowPatternsData;
  modelDelegation: ModelDelegationData;
  errorPropagation: ErrorPropagationData;
  concurrency: ConcurrencyData;
  complexity: SessionComplexityItem[];
  compaction: CompactionImpactData;
  cooccurrence: Array<{ source: string; target: string; weight: number }>;
}

export interface SessionDrillIn {
  session: Session;
  tree: Array<{
    id: string;
    name: string;
    type: string;
    subagent_type: string | null;
    status: string;
    task: string | null;
    started_at: string;
    ended_at: string | null;
    children: SessionDrillIn["tree"];
  }>;
  toolTimeline: Array<{
    id: number;
    tool_name: string;
    event_type: string;
    agent_id: string | null;
    created_at: string;
    summary: string | null;
  }>;
  swimLanes: Array<{
    id: string;
    name: string;
    type: string;
    subagent_type: string | null;
    status: string;
    started_at: string;
    ended_at: string | null;
    parent_agent_id: string | null;
  }>;
  events: DashboardEvent[];
}

// ── Workflow-tool runs (issue #167) ──────────────────────────────────────────
// Fleets of inner sub-agents spawned by the Claude Code "Workflow" tool,
// ingested from the on-disk run journal. Distinct from WorkflowData above
// (which is events-derived analytics).
export interface WorkflowPhase {
  title?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface WorkflowProgressEntry {
  /** "workflow_agent" (a real inner agent) or "workflow_phase" (a phase marker). */
  type?: string;
  agentId?: string;
  agentType?: string | null;
  model?: string | null;
  state?: string | null;
  label?: string | null;
  phaseTitle?: string | null;
  startedAt?: string | number | null;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number | null;
  lastToolName?: string | null;
  promptPreview?: string | null;
  resultPreview?: string | null;
  [key: string]: unknown;
}

export interface WorkflowRun {
  run_id: string;
  session_id: string;
  task_id: string | null;
  name: string | null;
  status: string;
  default_model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  agent_count: number;
  total_tokens: number;
  total_tool_calls: number;
  phases: WorkflowPhase[];
  progress: WorkflowProgressEntry[];
  script_path: string | null;
  journal_path: string | null;
  source: "journal" | "live";
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunsResponse {
  runs: WorkflowRun[];
  total: number;
  counts: Record<string, number>;
  limit: number;
  offset: number;
}

export interface WorkflowRunDetail {
  workflow: WorkflowRun;
  agents: Agent[];
  events: DashboardEvent[];
}

export const STATUS_CONFIG: Record<
  EffectiveAgentStatus,
  { labelKey: string; color: string; bg: string; dot: string }
> = {
  working: {
    labelKey: "common:status.working",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  waiting: {
    labelKey: "common:status.waiting",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/20",
    dot: "bg-yellow-400",
  },
  completed: {
    labelKey: "common:status.completed",
    color: "text-violet-400",
    bg: "bg-violet-500/10 border-violet-500/20",
    dot: "bg-violet-400",
  },
  error: {
    labelKey: "common:status.error",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/20",
    dot: "bg-red-400",
  },
};

// ── Transcript / Conversation types ──

export interface TranscriptContent {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown> | { _truncated: string };
  output?: string;
  is_error?: boolean;
}

/** Who actually sent a transcript message. A JSONL `type:"user"` line can be the
 *  human, a tool result, a harness injection, or (in a subagent transcript) the
 *  task handed down by the orchestrator - `sender` disambiguates for display. */
export type TranscriptSender = "user" | "assistant" | "orchestrator" | "system" | "tool";

export interface TranscriptMessage {
  type: "user" | "assistant" | "session_event";
  /** True sender, classified server-side. Falls back to `type` when absent. */
  sender?: TranscriptSender;
  timestamp: string | null;
  content: TranscriptContent[];
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** For type === "session_event": the TUI action this marker represents.
   *  "rename" is a /rename, `claude -n`, or picker Ctrl+R title change. */
  event_kind?: "rename";
  /** For type === "session_event": the new session title. */
  title?: string;
}

export interface TranscriptResult {
  messages: TranscriptMessage[];
  total: number;
  has_more: boolean;
  last_line: number;
  first_line: number;
}

export interface TranscriptInfo {
  id: string;
  name: string;
  type: "main" | "subagent" | "compaction";
  subagent_type?: string | null;
  has_transcript: boolean;
  db_agent_id?: string | null;
}

export interface TranscriptListResult {
  transcripts: TranscriptInfo[];
}

// ── Multi-provider chat (Phase E) ───────────────────────────────────────────
export interface ChatModelOption {
  id: string;
  label: string;
}

export interface ChatProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  /** vision (Phase Q1): the provider can see attached images. */
  capabilities: { chat: boolean; image: boolean; vision?: boolean; tools?: boolean };
  models: ChatModelOption[];
  defaultModel: string | null;
  disabled?: boolean;
  note?: string;
}

/** OpenGraph link-preview card (Phase Q2). */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/** One uploaded chat attachment (Phase Q1) - as stored on the message. */
export interface ChatAttachment {
  /** Server-generated stored filename (serves at /api/chat/uploads/<file>). */
  file: string;
  /** Original filename, for display. */
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text";
  /** Present on the upload response only. */
  url?: string;
}

export interface ProvidersConfig {
  gemini: {
    enabled: boolean;
    hasApiKey: boolean;
    chatModels: string[];
    defaultModel: string;
    imageModel: string;
  };
  ollama: { enabled: boolean; host: string; defaultModel: string };
  claude: { enabled: boolean; chatModels: string[]; defaultModel: string };
  openai: OpenAICompatProviderConfig;
  deepseek: OpenAICompatProviderConfig;
  nvidia: OpenAICompatProviderConfig;
}

/** Redacted config shape shared by the OpenAI-compatible providers (Phase Q1). */
export interface OpenAICompatProviderConfig {
  enabled: boolean;
  hasApiKey: boolean;
  baseUrl: string;
  chatModels: string[];
  defaultModel: string;
}

export interface Chat {
  id: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  cc_session_id: string | null;
  /** Project tag (Phase F) - chats have no cwd, so this is only ever set explicitly. */
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  provider: string | null;
  model: string | null;
  content: string;
  image_path: string | null;
  /** Uploaded attachments (Phase Q1); the server returns a parsed array. */
  attachments?: ChatAttachment[];
  created_at: string;
}

export const SESSION_STATUS_CONFIG: Record<
  EffectiveSessionStatus,
  { labelKey: string; color: string; bg: string; dot: string }
> = {
  active: {
    labelKey: "common:status.active",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  waiting: {
    labelKey: "common:status.waiting",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/20",
    dot: "bg-yellow-400",
  },
  completed: {
    labelKey: "common:status.completed",
    color: "text-violet-400",
    bg: "bg-violet-500/10 border-violet-500/20",
    dot: "bg-violet-400",
  },
  error: {
    labelKey: "common:status.error",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/20",
    dot: "bg-red-400",
  },
  abandoned: {
    // Muted slate distinguishes "given up / faded out" from yellow Waiting
    // (attention required).
    labelKey: "common:status.abandoned",
    color: "text-slate-400",
    bg: "bg-slate-500/10 border-slate-500/20",
    dot: "bg-slate-400",
  },
};
