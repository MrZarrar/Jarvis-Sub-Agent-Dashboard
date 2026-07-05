# API Reference

Complete REST API and WebSocket documentation for Agent Dashboard.

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Base URL](#base-url)
- [REST API](#rest-api)
  - [Sessions](#sessions)
  - [Agents](#agents)
  - [Tools](#tools)
  - [Pricing](#pricing)
  - [Notifications](#notifications)
- [WebSocket API](#websocket-api)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Pagination](#pagination)
- [Examples](#examples)

---

## Overview

The Agent Dashboard API provides programmatic access to Claude Code session monitoring data.

```mermaid
graph LR
    Client[API Client] -->|HTTP/HTTPS| REST[REST API<br/>:4820/api/*]
    Client -->|WebSocket| WS[WebSocket<br/>:4820/ws]
    
    REST --> DB[(SQLite)]
    WS --> Broadcast[Real-time<br/>Broadcasts]
    
    style REST fill:#10B981
    style WS fill:#F59E0B
    style DB fill:#003B57,color:#fff
```

**Protocols:**
- **REST API** - HTTP/JSON for queries and mutations
- **WebSocket** - Real-time event streaming

---

## Authentication

The server is **local-first** and is hardened to keep the dashboard off the network by default (see GHSA-gr74-4xfh-6jw9). The trust boundary is the loopback bind, layered with origin and host checks:

- **Loopback bind by default** - the server binds `127.0.0.1`, so it is not network-reachable out of the box. Operators opt into a wider bind with `DASHBOARD_HOST` (e.g. `DASHBOARD_HOST=0.0.0.0` for LAN access), which logs a startup warning.
- **CORS restricted to loopback origins** - cross-origin web pages cannot read API responses. Requests with no `Origin` (curl, server-to-server) still work.
- **Host-header allowlist** - both HTTP requests and WebSocket upgrades are checked against an allowlist to block DNS-rebinding. Add extra LAN names (when you bind beyond loopback) via `DASHBOARD_ALLOWED_HOSTS` (comma-separated).

For deliberate LAN exposure, set `DASHBOARD_HOST` to a non-loopback address and list the names clients use in `DASHBOARD_ALLOWED_HOSTS`.

### Optional token (`DASHBOARD_TOKEN`)

Authentication is **off by default** (the loopback bind is the trust boundary). When `DASHBOARD_TOKEN` is set, every `/api/*` request **and** the WebSocket must present the token. It is strongly recommended whenever you bind beyond loopback. Pass it any of these ways:

- `Authorization: Bearer <token>` header
- `x-dashboard-token: <token>` header
- `?token=<token>` query parameter

These paths stay exempt even when a token is configured: `/api/health`, `/api/openapi.json`, `/api/docs`, and `/api/hooks` (local Claude Code hook ingestion). Requests that fail the check get `401` with error code `EUNAUTHORIZED`.

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Auth
    participant Resource
    
    Client->>API: Request + DASHBOARD_TOKEN
    API->>Auth: Validate token (if configured)
    Auth-->>API: Valid
    API->>Resource: Fetch Data
    Resource-->>API: Return Data
    API-->>Client: 200 OK + Data
```

---

## Base URL

```
http://localhost:4820
```

For production, use HTTPS:

```
https://dashboard.example.com
```

---

## REST API

### Sessions

#### List Sessions

```http
GET /api/sessions
```

Returns all sessions, ordered by most recent activity.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Maximum sessions to return (1-1000) |
| `offset` | integer | 0 | Pagination offset |
| `status` | string | - | Filter by persisted status: `active`, `completed`, `error`, `abandoned`. The UI **Waiting** state is derived from the `awaiting_input_since` column and is not a queryable enum - filter `status=active` and inspect `awaiting_input_since` (non-null = Waiting) |

**Example Request:**

```bash
curl http://localhost:4820/api/sessions?limit=10&status=active
```

**Example Response:**

```json
{
  "sessions": [
    {
      "id": 1,
      "session_id": "sess_abc123",
      "model": "claude-sonnet-4",
      "status": "active",
      "total_cost": 1.23,
      "agent_count": 3,
      "tool_count": 12,
      "created_at": "2024-03-18T12:00:00Z",
      "updated_at": "2024-03-18T14:30:00Z"
    }
  ],
  "total": 42,
  "limit": 10,
  "offset": 0
}
```

**Response Schema:**

```mermaid
classDiagram
    class SessionListResponse {
        +Session[] sessions
        +number total
        +number limit
        +number offset
    }
    
    class Session {
        +string id
        +string name
        +string status "active|completed|error|abandoned"
        +string cwd
        +string model
        +string started_at
        +string ended_at
        +string updated_at
        +string awaiting_input_since "null unless Waiting"
        +number cost
        +number agent_count
    }
    
    SessionListResponse --> Session
```

---

#### Get Session

```http
GET /api/sessions/:id
```

Returns single session details.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Session ID (e.g., `sess_abc123`) |

**Example Request:**

```bash
curl http://localhost:4820/api/sessions/sess_abc123
```

**Example Response:**

```json
{
  "session": {
    "id": 1,
    "session_id": "sess_abc123",
    "model": "claude-sonnet-4",
    "status": "active",
    "total_cost": 1.23,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T14:30:00Z"
  }
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 404 | Session not found |
| 500 | Internal server error |

---

#### Get Session Stats

```http
GET /api/sessions/:id/stats
```

Returns aggregated counts powering the Session Detail overview panel. All aggregation runs in SQL - the response is cheap to compute even for sessions with tens of thousands of events.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Session ID |

**Example Request:**

```bash
curl http://localhost:4820/api/sessions/sess_abc123/stats
```

**Example Response:**

```json
{
  "session_id": "sess_abc123",
  "total_events": 14082,
  "events_by_type": [
    { "event_type": "PreToolUse", "count": 5210 },
    { "event_type": "PostToolUse", "count": 5208 }
  ],
  "tools_used": [
    { "tool_name": "Bash", "count": 1842 },
    { "tool_name": "Read", "count": 1340 }
  ],
  "error_count": 12,
  "first_event_at": "2026-04-26T18:59:00.000Z",
  "last_event_at": "2026-04-29T21:30:14.000Z",
  "agents": {
    "total": 12,
    "main": 1,
    "subagent": 11,
    "compaction": 5,
    "by_status": { "completed": 11, "working": 1 }
  },
  "subagent_types": [
    { "subagent_type": "Explore", "count": 4 }
  ],
  "tokens": {
    "input_tokens": 1376,
    "output_tokens": 760304,
    "cache_read_tokens": 337641891,
    "cache_write_tokens": 5126047
  }
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 404 | Session not found |
| 500 | Internal server error |

---

#### Get Session Agents

```http
GET /api/sessions/:id/agents
```

Returns all agents for a session.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Session ID |

**Example Request:**

```bash
curl http://localhost:4820/api/sessions/sess_abc123/agents
```

**Example Response:**

```json
{
  "agents": [
    {
      "id": "sess_abc123-main",
      "session_id": "sess_abc123",
      "name": "Main Agent - my-project",
      "type": "main",
      "subagent_type": null,
      "status": "idle",
      "current_tool": null,
      "task": null,
      "started_at": "2024-03-18T12:00:00Z",
      "ended_at": null,
      "updated_at": "2024-03-18T12:05:00Z",
      "parent_agent_id": null,
      "awaiting_input_since": "2024-03-18T12:05:00Z",
      "cost": 0
    }
  ]
}
```

> **Note on `cost`** - `/api/agents` and `/api/sessions/:id/agents` attach a `cost` (USD) to each agent: the agent's **own** cost, computed server-side from the per-agent token buckets stored in `agents.metadata.tokens` and priced at the current pricing rules (at the agent's start date, so promo/standard cutovers apply - see [Pricing](#pricing)). It is `0` for main agents (whose cost is the session total, reported by `/api/pricing/cost/:sessionId`), for compaction pseudo-agents, and for any subagent whose transcript is unavailable. This lets a subagent card show only what that subagent spent instead of the whole session's total.

> **Note on `status` vs Waiting** - agents are persisted with one of `idle | connected | working | completed | error`. The yellow **Waiting** badge surfaced in the dashboard is a UI overlay derived from `awaiting_input_since` being non-null on a non-terminal agent (typically `idle` after a `Stop`, or `connected` right after `SessionStart`). Filter `?status=idle` on `/api/agents` and inspect `awaiting_input_since` to enumerate currently-waiting main agents.

---

### Agents

#### Get Agent

```http
GET /api/agents/:id
```

Returns single agent details.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent ID (e.g., `agent_xyz789`) |

**Example Request:**

```bash
curl http://localhost:4820/api/agents/agent_xyz789
```

**Example Response:**

```json
{
  "agent": {
    "id": 1,
    "agent_id": "agent_xyz789",
    "session_id": "sess_abc123",
    "agent_type": "explore",
    "status": "completed",
    "current_tool": null,
    "input_tokens": 1500,
    "output_tokens": 800,
    "cost": 0.45,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T12:05:00Z"
  }
}
```

---

#### Get Agent Tools

```http
GET /api/agents/:id/tools
```

Returns tool executions for an agent.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent ID |

**Example Request:**

```bash
curl http://localhost:4820/api/agents/agent_xyz789/tools
```

**Example Response:**

```json
{
  "tools": [
    {
      "id": 1,
      "agent_id": "agent_xyz789",
      "tool_name": "bash",
      "duration_ms": 1234,
      "success": 1,
      "error_message": null,
      "created_at": "2024-03-18T12:01:00Z"
    },
    {
      "id": 2,
      "agent_id": "agent_xyz789",
      "tool_name": "view",
      "duration_ms": 45,
      "success": 1,
      "error_message": null,
      "created_at": "2024-03-18T12:02:00Z"
    }
  ]
}
```

**Tool Execution Flow:**

```mermaid
sequenceDiagram
    participant Agent
    participant PreHook as PreToolUse Hook
    participant Tool as Tool Execution
    participant PostHook as PostToolUse Hook
    participant DB as Database
    
    Agent->>PreHook: Tool about to execute
    PreHook->>DB: Set current_tool
    
    Agent->>Tool: Execute (bash, view, etc.)
    Tool-->>Agent: Result
    
    Agent->>PostHook: Tool completed
    PostHook->>DB: Create tool_execution record
    PostHook->>DB: Clear current_tool
    PostHook->>DB: Update token counts + cost
```

---

### Tools

#### List All Tools

```http
GET /api/tools
```

Returns all tool executions across all sessions.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Max tools to return |
| `tool_name` | string | - | Filter by tool name |
| `success` | boolean | - | Filter by success status |

**Example Request:**

```bash
curl http://localhost:4820/api/tools?limit=50&tool_name=bash
```

**Example Response:**

```json
{
  "tools": [
    {
      "id": 1,
      "agent_id": "agent_xyz789",
      "tool_name": "bash",
      "duration_ms": 1234,
      "success": 1,
      "error_message": null,
      "created_at": "2024-03-18T12:01:00Z"
    }
  ],
  "total": 156
}
```

---

### Pricing

#### List Pricing Rules

```http
GET /api/pricing
```

Returns all pricing rules (default + custom).

**Example Request:**

```bash
curl http://localhost:4820/api/pricing
```

**Example Response:**

```json
{
  "rules": [
    {
      "id": 1,
      "pattern": "claude-sonnet-4",
      "input_cost_per_1m": 3.0,
      "output_cost_per_1m": 15.0,
      "is_default": true,
      "created_at": "2024-03-18T12:00:00Z"
    },
    {
      "id": 10,
      "pattern": "gpt-5.1-codex",
      "input_cost_per_1m": 2.5,
      "output_cost_per_1m": 10.0,
      "is_default": false,
      "created_at": "2024-03-18T14:30:00Z"
    }
  ]
}
```

**Pricing Rule Matching:**

```mermaid
graph TB
    Model[Model Name<br/>e.g., claude-sonnet-4] --> Match{Match Pattern?}
    
    Match -->|Exact Match| Custom[Use Custom Rule]
    Match -->|Substring Match| Default[Use Default Rule]
    Match -->|No Match| Fallback[Use Generic Fallback]
    
    Custom --> Calculate[Calculate Cost]
    Default --> Calculate
    Fallback --> Calculate
    
    Calculate --> Result[input_cost + output_cost]
    
    style Calculate fill:#10B981
```

---

#### Create or Update Pricing Rule

```http
PUT /api/pricing
```

Upsert a pricing rule, keyed by `model_pattern`. The same call creates a new rule or updates an existing one (matched on `model_pattern`). Rates are per **million** tokens.

**Request Body:**

```json
{
  "model_pattern": "claude-sonnet-5%",
  "display_name": "Claude Sonnet 5",
  "input_per_mtok": 3,
  "output_per_mtok": 15,
  "cache_read_per_mtok": 0.3,
  "cache_write_per_mtok": 3.75,
  "cache_write_1h_per_mtok": 6,
  "fast_input_per_mtok": 0,
  "fast_output_per_mtok": 0,

  "intro_until": "2026-08-31",
  "intro_input_per_mtok": 2,
  "intro_output_per_mtok": 10,
  "intro_cache_read_per_mtok": 0.2,
  "intro_cache_write_per_mtok": 2.5,
  "intro_cache_write_1h_per_mtok": 4
}
```

**Fields:**

| Field | Type | Constraints |
|-------|------|-------------|
| `model_pattern` | string | Required. SQL-style glob; `%` matches any characters (e.g. `claude-opus-4-7%`) |
| `display_name` | string | Required |
| `input_per_mtok` / `output_per_mtok` | number | Standard per-MTok rates (default 0) |
| `cache_read_per_mtok` / `cache_write_per_mtok` / `cache_write_1h_per_mtok` | number | Cache rates (default 0) |
| `fast_input_per_mtok` / `fast_output_per_mtok` | number | Fast-mode premium rates (default 0) |
| `intro_until` | string \| null | Optional promo cutoff `YYYY-MM-DD`. Usage **on or before** this date is priced at the `intro_*` rates, after it at the standard rates. Empty/`null` clears the promo (and zeroes the intro rates) |
| `intro_*_per_mtok` | number | Optional introductory (promo) rates, mirroring the standard fields |

The intro block is **optional and backward-compatible**: a request that omits every `intro_*`/`intro_until` field leaves any existing promo untouched, so older clients that send only the standard rates never clobber a promo.

**Example Request:**

```bash
curl -X PUT http://localhost:4820/api/pricing \
  -H "Content-Type: application/json" \
  -d '{
    "model_pattern": "gpt-5.1-codex",
    "display_name": "GPT-5.1 Codex",
    "input_per_mtok": 2.5,
    "output_per_mtok": 10.0
  }'
```

**Example Response:**

```json
{
  "pricing": {
    "model_pattern": "gpt-5.1-codex",
    "display_name": "GPT-5.1 Codex",
    "input_per_mtok": 2.5,
    "output_per_mtok": 10.0,
    "intro_until": null,
    "updated_at": "2026-07-01T14:30:00Z"
  }
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing `model_pattern`/`display_name`, or `intro_until` not a `YYYY-MM-DD` date |
| 500 | Database error |

---

#### Delete Pricing Rule

```http
DELETE /api/pricing/:pattern
```

Delete custom pricing rule (default rules cannot be deleted).

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Pattern to delete (URL-encoded) |

**Example Request:**

```bash
# Pattern must be URL-encoded
curl -X DELETE http://localhost:4820/api/pricing/gpt-5.1-codex
```

**Example Response:**

```json
{
  "deleted": true
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 404 | Pattern not found |
| 403 | Cannot delete default rule |
| 500 | Database error |

---

### Notifications

#### Get Session Notifications

```http
GET /api/sessions/:id/notifications
```

Returns notifications for a session.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Session ID |

**Example Request:**

```bash
curl http://localhost:4820/api/sessions/sess_abc123/notifications
```

**Example Response:**

```json
{
  "notifications": [
    {
      "id": 1,
      "session_id": "sess_abc123",
      "notification_type": "backgroundTaskComplete",
      "message": "Explore agent completed",
      "created_at": "2024-03-18T12:05:00Z"
    }
  ]
}
```

### Claude Config Explorer

The `/api/cc-config/*` namespace powers the Claude Config Explorer page. All read endpoints are pure file reads under `CLAUDE_HOME` and the project's `.claude/` dir; mutations are limited to low-risk text-file artifacts (skills, subagents, slash commands, output styles, memory) and always create a timestamped backup before writing. Plugins, MCP servers, hooks-in-settings, and live `settings.json` files stay read-only because they are written concurrently by the running Claude Code CLI.

```http
GET /api/cc-config/overview
GET /api/cc-config/skills?scope=user|project|all
GET /api/cc-config/agents
GET /api/cc-config/commands
GET /api/cc-config/output-styles
GET /api/cc-config/plugins
GET /api/cc-config/marketplaces
GET /api/cc-config/mcp
GET /api/cc-config/hooks
GET /api/cc-config/hook-scripts
GET /api/cc-config/keybindings
GET /api/cc-config/statusline
GET /api/cc-config/settings
GET /api/cc-config/memory
GET /api/cc-config/file?path=<absolute-path>
GET /api/cc-config/backups[?scope=&type=]
PUT /api/cc-config/file        Body: { scope, type, name?, content }
DELETE /api/cc-config/file     Body: { scope, type, name? }
```

`scope` is `"user"`, `"project"`, or `"auto-memory"`. `type` is one of `skills`, `agents`, `commands`, `output-styles`, `memory`, `auto-memory`. `name` is required for everything except `memory` (which is `CLAUDE.md` itself). On `PUT`, `name` is validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (for `auto-memory` it must instead be a flat `*.md` filename). Settings are returned with secret-like keys (matching `/token|secret|password|api[_-]?key|auth/i`) replaced by `"<redacted>"`.

`GET /api/cc-config/memory` also surfaces the per-project file-based memory store - every `*.md` under `~/.claude/projects/<slug>/memory/` (the common pattern of a `MEMORY.md` index plus one file per remembered fact). Those items have `scope: "auto-memory"` and carry `project` (the `projects/<slug>` dir name), `name` (filename), `isIndex` (true for `MEMORY.md` / `INDEX-*.md`, which sort first), and parsed `frontmatter`. They are **editable**: `PUT`/`DELETE /api/cc-config/file` accept `{ scope: "auto-memory", type: "auto-memory", project, name, content? }` and create a timestamped backup under `<memory-dir>/.cc-config-backups/auto-memory/` before mutating (an invalid `project` slug returns `EBADPROJECT`). `GET /api/cc-config/backups` lists these with `scope: "auto-memory"` and `project` set. Bodies are also readable via `GET /api/cc-config/file` (they live under `CLAUDE_HOME`).

Backup paths look like `<root>/cc-config-backups/<type>/<base>.<ISO>.bak[.dir]` - outside the directories Claude Code scans, so a deleted skill cannot resurface as a backup-named one. The Backups modal in the UI auto-builds `mv` restore commands.

### Run Claude

The `/api/run/*` namespace spawns and supervises `claude` subprocesses from the dashboard. Every route enforces a same-origin / loopback-Origin guard; browser requests must come from `localhost`, `127.0.0.1`, `::1`, or `0.0.0.0`. CLI / curl requests with no `Origin` header pass through. When `DASHBOARD_TOKEN` is set, a valid token is also required here (like the rest of `/api/*` - see [Authentication](#authentication)).

```http
GET    /api/run                       List all handles + concurrency state
GET    /api/run/binary                { found, path } for the `claude` binary
GET    /api/run/cwds                  Suggested cwds (dashboard, home, recent)
GET    /api/run/files?cwd=&q=         Fuzzy file search inside cwd for the @-file autocomplete
                                       (skips node_modules, .git, dist, build, .next, .cache, coverage, vendor)
POST   /api/run                       Spawn - Body: { prompt, mode, cwd?, model?, permissionMode?, permissionUx?, resumeSessionId?, effort? }
POST   /api/run/:id/message           Send follow-up turn - Body: { text }
GET    /api/run/:id[?envelopes=1]     Handle state (incl. `pendingPermissions`); ?envelopes=1 includes the in-memory envelope log
DELETE /api/run/:id                   Stop (SIGTERM → SIGKILL after 5 s)

GET    /api/run/:id/permissions              List every interactive permission request for a run (pending + resolved)
POST   /api/run/:id/permission/request       Hook opens a request - Body: { toolUseId, toolName?, toolInput? } (409 EBADREQUEST unless the run opted into permissionUx:"interactive")
GET    /api/run/:id/permission/request/:rid  Hook short-polls for a decision
POST   /api/run/:id/permission/request/:rid  Dashboard UI records the decision - Body: { decision: "allow"|"deny", reason? }
```

`mode` is `"headless"` (single-shot, stdin closed after spawn, prompt in argv via `-p`) or `"conversation"` (multi-turn, stdin stays open, prompt and follow-ups piped as stream-json envelopes). `resumeSessionId` requires conversation mode and adds `--resume <id>` so the run continues an existing Claude Code session - the cwd is locked to the original session's cwd. **When `resumeSessionId` is set, `prompt` may be empty** - the spawner skips the initial stdin write and `claude --resume` idles on the resumed conversation until the user posts a follow-up via `POST /api/run/:id/message`. Headless mode and fresh conversations still require a non-empty prompt (`EBADPROMPT` otherwise). `effort` (`"low"` / `"medium"` / `"high"`) maps to `--effort` and tunes the model's thinking budget. The spawner always passes `--output-format stream-json --verbose --include-partial-messages` so output streams over the existing dashboard WebSocket as `run_stream` (parsed envelopes, including `stream_event` deltas for character-by-character rendering), `run_status` (status transitions), and `run_input_ack` (stdin write confirmed). Concurrency is effectively uncapped (default ceiling 10000, override with `RUN_MAX_CONCURRENT`) - the terminal TUI has no cap and neither does the dashboard; the ceiling exists only to prevent fork-bomb footguns from a buggy client.

**Interactive permissions** (`permissionUx: "interactive"`, opt-in only - any other value or omission is a no-op): arms `scripts/permission-gate.js` as a PreToolUse hook on the spawned `claude` process. Every tool call opens a request via `POST /api/run/:id/permission/request` and the hook short-polls `GET .../permission/request/:rid` (its own 10-minute hard cap denies on timeout; the server applies an 11-minute safety-net TTL that also resolves to `deny` - fail toward safety, never toward allow). The Run page renders pending requests with Allow/Deny buttons (`client/src/components/PermissionRequests.tsx`), seeded from `GET /api/run/:id/permissions` on attach/reconnect and kept live via the `permission_request` / `permission_resolved` WebSocket broadcasts below. A new pending request also fires a web-push notification (`server/lib/push.js`, see [README.md § Browser Notifications](../README.md#browser-notifications)) deep-linking to `/run?runId=<id>#permission-<requestId>` - `sendPushToAll(db, title, body, url)` carries the optional `url` as `data.url` in the push payload, and `client/public/sw.js`'s `notificationclick` handler navigates there on tap.

Spawned `claude` processes fire the dashboard's hooks like any other CLI session, so they show up in `/api/sessions`, the analytics, the Kanban board, and the Workflows page automatically - the Run page itself just owns the live streaming UX.

---

### Accounts (multi-account / claude-swap, Phase K)

Read-only view of the two Claude accounts the user runs via [claude-swap](https://github.com/realiti4/claude-swap). The dashboard **observes** claude-swap's state files (`server/lib/claude-swap.js` watches `~/.claude-swap-backup/autoswitch_state.json`) and never performs a swap itself.

```
GET    /api/accounts                  { present, activeAccountId, accounts[], swaps[] }
```

`present` is `false` when claude-swap isn't detected - a single-account setup gets an empty, inert payload and the UI hides its multi-account chrome. Each `accounts[]` row is `{ id, label, active, first_seen, last_active, resets_at, metadata }`; `swaps[]` is the recent swap history `{ id, from_account, to_account, reason, created_at }`. An active-account transition broadcasts `account_swapped` over the WebSocket and fires an `account_swaps`-category push. Runs spawned from the dashboard are tagged with the account active at spawn time (`dashboard_runs.account_id`). Overrides: `CLAUDE_SWAP_BACKUP_DIR` (state dir), `CLAUDE_SWAP_POLL_MS` (safety-net poll, default 60000; `0` disables it and leaves the fs.watch on).

### Schedules (scheduled & chained prompts, Phase L)

CRUD for deferred and chained prompts, backed by `server/lib/scheduler.js`. Reuses the Run router's loopback-Origin guard (firing a schedule can spawn a `claude` process).

```
GET    /api/schedules[?status=]       List (status: pending|fired|cancelled|failed) → { items[], maxChainDepth }
POST   /api/schedules                 Create - see body below → { schedule }
GET    /api/schedules/:id             One → { schedule }
PATCH  /api/schedules/:id             Edit a pending schedule - Body: { label?, prompt?, fireAt?, statusFilter? }
DELETE /api/schedules/:id[?cascade=1] Cancel a pending schedule; cascade also cancels its chained dependents
```

Create body: `{ prompt, targetKind, targetOpts?, triggerKind, fireAt?, triggerRunId?, statusFilter?, label? }`.

- `triggerKind` - `"at"` (fire at `fireAt`, an ISO timestamp; a missed time on restart fires immediately with a `late` flag) or `"on_run_complete"` (fire when the run `triggerRunId` reaches a terminal status; `statusFilter: "success"` fires only on a clean exit, otherwise the schedule is cancelled).
- `targetKind` - `"new_run"` (spawn a fresh run with `targetOpts` `{ cwd?, model?, mode?, permissionMode?, permissionUx?, effort? }` through the normal spawn path) or `"session_message"` (deliver `prompt` into the live run `targetOpts.runId`, the same path as `POST /api/run/:id/message`).
- `on_run_complete` prompts interpolate `{status}`, `{exitCode}`, and `{runId}` from the completed run. A fired run can itself be the trigger of another schedule (chaining), bounded by `maxChainDepth`.

Fires/failures broadcast `schedule_created` / `schedule_updated` / `schedule_cancelled` / `schedule_fired` / `schedule_failed` and fire an optional `scheduled_prompts`-category push. Pending schedules are re-armed from SQLite on server boot; the scheduler is fail-safe and never takes down the server or the watched run.

---

### Notifications inbox (Phase O)

The durable inbox behind the Tabby ball's badge + Inbox tab. Rows are written
server-side by the `server/lib/notify.js` facade (every push producer routes
through it — see `docs/NOTIFICATIONS.md` for the copy rules and producer table).

```
GET  /api/notifications?unread=1&limit=50   List (newest first) → { notifications[], unread }
POST /api/notifications/:id/read            Mark one read → { ok } (404 if unknown/already read)
POST /api/notifications/read-all            Mark everything read → { ok, marked }
```

Each notification is `{ id, category, title, body, data, source, dedupe_key, created_at, read_at }`
where `data` carries the deep link (`url`) plus entity ids. Creation broadcasts
`notification_created` (the full row); read state changes broadcast
`notification_read` (`{ ids }` or `{ all: true }`) so every open device's badge
syncs live.

### Assistant / Voice (Phase D)

One endpoint powers Siri Shortcuts, CarPlay, the notes chat, and quick actions, plus token-admin routes. Backed by `server/routes/assistant.js`, `server/lib/assistant.js` (intent prelude), `server/lib/assistant-token.js`, and the `server/lib/brain` stub.

```
POST   /api/assistant/ask             Ask Jarvis - Body: { text, source?, conversationId?, speak? } → { text, speech, intent, ... }
GET    /api/assistant/glance          Compact widget JSON (Phase T) → { runs, agents, sessions, window, captures, at }
POST   /api/share-target              PWA share-sheet target (Phase T) - multipart/urlencoded { title?, text?, url? } → 303 /notes (files a capture)
GET    /api/assistant/tokens          List tokens (hash-only, no secret) → { tokens[] }
POST   /api/assistant/tokens          Generate a token - Body: { label? } → { token } (plaintext shown once)
DELETE /api/assistant/tokens/:id      Revoke a token → { ok }
```

- **`/glance`** (Phase T) shares `/ask`'s auth + rate limit exactly - built for Shortcuts home-screen/Watch glances; recipes in `docs/jarvis-glance-widget.md`. **`/api/share-target`** is the manifest `share_target` action: an OS share navigation can't carry a bearer token, so it is token-exempt but bounded (small text fields only, into the capture inbox, through the audited action dispatcher).

- **`/ask` auth** - requires a scoped assistant bearer token (`Authorization: Bearer <token>` or `x-assistant-token`), generated in Settings → Voice & Siri and stored as a SHA-256 hash. This route is **exempt from the `DASHBOARD_TOKEN` gate** so a Shortcut carries only the assistant token - but it is never open: a caller with no browser Origin MUST present a valid token. The first-party web UI (loopback/allowlisted Origin) may call it without a token, still subject to `DASHBOARD_TOKEN` when set. Rate limited per token (`ASSISTANT_RATE_LIMIT`, default 60/min → HTTP 429 + `Retry-After`).
- **Token-admin routes** (`/tokens*`) are the opposite: NOT exempt (behind `DASHBOARD_TOKEN`) plus a loopback same-origin guard - the web UI only.
- **`speech`** is a short (~2 sentence), markdown-free, number-rounded variant of `text` for text-to-speech.
- **`intent`** - `status` | `kill` | `steer` | `note` | `run_skill` | `chat` (fell through to the brain) | `empty`. The brain is a **stub** in this phase (`provider: "stub"`); Phase G swaps in the real router without changing this contract. `note:` dumps are captured to `assistant_captures` (drained by Phase G Notes).

See `docs/jarvis-siri-shortcut.md` and SETUP.md for the Shortcut recipe.

---

### Multi-provider chat (Phase E)

The Chat page's backend. Provider adapters live in `server/lib/providers/`
(`gemini` / `ollama` / `claude` chat adapters + `agent/` for spawnable
backends); routes in `server/routes/chat.js`. First-party web UI only, so the
whole surface sits behind the loopback same-origin guard. **Secrets are never
returned** - `GET /config` is redacted.

```
GET    /api/chat/providers            List chat providers + live models → { providers[] } (Gemini/Ollama/Claude/DeepSeek/NVIDIA/GPT)
GET    /api/chat/config               Redacted provider config (hasApiKey booleans, no secrets)
PUT    /api/chat/config               Update provider keys/hosts/models - Body: partial patch → { config } (redacted)
GET    /api/chat/chats                List conversations → { items[] }
POST   /api/chat/chats                Create a conversation - Body: { title?, provider?, model? } → { chat }
GET    /api/chat/chats/:id            Get a conversation → { chat, messages[] } (attachments parsed to arrays)
PATCH  /api/chat/chats/:id            Rename - Body: { title } → { chat }
DELETE /api/chat/chats/:id            Delete a conversation (cascades messages) → { ok }
POST   /api/chat/chats/:id/messages   Send a turn - Body: { text, provider?, model?, attachments? } → text/event-stream (SSE)
POST   /api/chat/chats/:id/image      Generate an image (Gemini) - Body: { prompt, model? } → { message, url }
GET    /api/chat/images/:file         Serve a generated image (strict filename validation)
POST   /api/chat/upload               Upload one attachment (Phase Q1; multipart field `file`) → { attachment }
GET    /api/chat/uploads/:file        Serve an uploaded attachment (strict filename validation)
GET    /api/chat/link-preview?url=    OpenGraph card for a URL (Phase Q2, SSRF-guarded) → { preview }
```

- **Attachments (Phase Q1).** `POST /upload` accepts images (png/jpeg/webp/gif,
  ≤8MB) and text-ish files (≤256KB) and returns
  `{ attachment: { file, name, mimeType, size, kind, url } }` — pass an array of
  those back as `attachments` on `/messages`. The server accepts only files the
  upload route produced (stored-name pattern + existence check). Text
  attachments inline into the prompt (24KB cap per file) for **every**
  provider; image attachments become Gemini `inlineData` vision parts —
  providers without `capabilities.vision` get an honest `[Image attached … not
  visible to this provider]` note instead of a silently-dropped image.
- **In-chat preview (Phase Q2).** Fenced `html`/`svg`/`xml` blocks in any chat
  reply get a **Preview** toggle rendering the code in a sandboxed iframe
  (`sandbox="allow-scripts"`, **no** `allow-same-origin` — opaque origin, no
  cookies/storage/API reach). `GET /link-preview` fetches a page's OpenGraph
  tags server-side with SSRF hygiene: http/https only, hostname must resolve to
  public addresses (loopback/RFC1918/link-local/CGNAT and IPv6 equivalents
  rejected), every redirect hop re-validated (max 3), 5s timeout, 128KB body
  cap. The Chat page renders a card for the first URL in a message.
- **OpenAI-compatible providers (Phase Q1).** `providers/openai-compat.js` is
  one adapter instantiated for **DeepSeek** (`api.deepseek.com`), **NVIDIA
  NIM** (`integrate.api.nvidia.com/v1`), and **OpenAI** (the formerly-inert
  GPT slot — real once a key exists). Keys via Settings → AI Providers or the
  `DEEPSEEK_API_KEY` / `NVIDIA_API_KEY` / `OPENAI_API_KEY` env fallbacks.

- **Streaming (`/messages`)** responds with **Server-Sent Events**, not JSON:
  `event: user` (the persisted user message), repeated `event: delta`
  (`{ text }`), then `event: done` (`{ message }`) or `event: error`
  (`{ message }`). Deliberately independent of the WebSocket layer. Consumed
  client-side by `streamChatMessage` in `client/src/lib/api.ts`.
- **Agentic provider picker.** `GET /api/run/providers` lists the spawnable
  backends (`claude` default, `gemini-cli`); `POST /api/run` accepts a
  `provider` field. Gemini runs are headless with **no permission gate** (the
  gate is Claude-only). The Claude path is byte-identical to before.

---

### Projects (Phase F)

The dashboard-native organizing dimension over sessions, dashboard-spawned runs, and chats - **deliberately separate from Claude.ai's own "Projects" feature**; nothing here talks to any Anthropic API. Backed by `server/lib/projects.js`, routes in `server/routes/projects.js`. Plain CRUD with no process-spawning or outbound-API side effects, so - unlike Run/Chat/Schedules - it sits behind only the global host/CORS/`DASHBOARD_TOKEN` guard, no extra same-origin guard.

```
GET    /api/projects                       List (?status=active|paused|done) → { items[] }, each with a lightweight rollup (limit 3)
POST   /api/projects                       Create - Body: { name, description?, status?, repoPath?, notesDir? } → { project }
GET    /api/projects/:id                   Get → { project, rollup, paths[] }
PATCH  /api/projects/:id                   Edit - Body: { name?, description?, status?, repoPath?, notesDir? } → { project }
DELETE /api/projects/:id                   Delete → { ok }
GET    /api/projects/:id/paths             List repo paths → { items[] }
POST   /api/projects/:id/paths             Add a repo path - Body: { repoPath } → { path, backfilled: { sessions, runs } }
DELETE /api/projects/:id/paths/:pathId     Remove a repo path → { ok }
```

- **Schema** - `projects` (`id, name, description, status: active|paused|done, repo_path?, notes_dir?, created_at, updated_at`) plus `project_paths` (`id, project_id, repo_path, created_at`) - one-to-many because a project may span multiple repos. Additive nullable `project_id` on `sessions`, `dashboard_runs`, and `chats`.
- **Archiving** is `PATCH { status: "done" }` - there is no separate archive endpoint.
- **Auto-association by cwd.** Hook-ingested sessions (`server/routes/hooks.js`, right after a new session is created) and dashboard-spawned runs (`server/lib/run-spawner.js`, resolved once at spawn time and persisted by `server/lib/dashboard-runs.js`) are both tagged by matching their `cwd` against the **longest matching** `project_paths` prefix (path-boundary aware - `/repo-2` never matches a registered `/repo`). `POST /api/run` also accepts an optional explicit `projectId` that wins over the cwd guess when supplied (no UI sends this yet; the field exists for a future project-scoped spawn action). The resolved id is exposed on the live run handle too (`GET /api/run/:id` → `projectId`).
- **Backfill.** `POST /api/projects/:id/paths` retroactively re-scans every existing session/run that has a cwd but no project yet and tags the ones that now match - so registering a path after the fact still associates prior history, not just future activity.
- **Chats have no cwd**, so `chats.project_id` is only ever set explicitly via the existing chat routes: `POST /api/chat/chats` and `PATCH /api/chat/chats/:id` both accept an optional `projectId` field. There is no Chat-page UI to set it yet.
- **Delete is non-destructive to activity.** `DELETE /api/projects/:id` un-tags (nulls `project_id` on) the sessions/dashboard_runs/chats it grouped, then removes the project row - the project is an organizing label, not the system of record for that history. `project_paths` rows cascade-delete via FK.

---

### Notes + mini-Jarvis brain (Phase G)

Notes are **markdown files on disk** (default `~/JarvisNotes`; override with the `JARVIS_NOTES_DIR` env var or `PUT /api/notes/config`). The files are the system of record; SQLite (`notes` + `notes_fts` FTS5) is a rebuildable index an `fs.watch` watcher keeps in sync - an edit made in Obsidian/anywhere reindexes live and broadcasts `note_changed`. Backed by `server/lib/notes.js` + `server/routes/notes.js`; plain CRUD (no process-spawning) behind the global guard, except `dump` which invokes the brain. FTS5 is created guarded (`NOTES_FTS_OK`) - search degrades to a substring scan if the SQLite build lacks it.

```
GET    /api/notes                          List/search - ?q= (FTS), ?tag=, ?project= → { items[] } (metadata, no body)
GET    /api/notes/:id                      Get one note with its markdown body → { note }
POST   /api/notes                          Create - Body: { title?, body?, tags?, projectId? } → { note }
PUT    /api/notes/:id                       Update - Body: { title?, body?, tags?, projectId? } → { note }
DELETE /api/notes/:id                      Delete (file + index) → { ok }
GET    /api/notes/tags                     Distinct tags with counts → { items: [{ tag, count }] }
GET    /api/notes/config                   { dir, default }
PUT    /api/notes/config                   Set notes dir - Body: { dir } → { dir, default }
POST   /api/notes/dump                     Brain-dump reformat - Body: { text, save?, projectId?, source? }
                                             save:false → preview { raw, formatted, provider, title, body, tags, todos }
                                             save:true  → also files a source:dump note (original preserved) → { ..., note }
GET    /api/notes/captures                 Pending voice/chat "note: …" capture inbox → { items[] }
POST   /api/notes/captures/:id/file        File a capture as a note (through the brain) → { note }
POST   /api/notes/captures/:id/discard     Drop a capture → { ok }
```

**Mini-Jarvis brain** (`server/lib/brain/`): a tiered task router - `simple`→Ollama, `standard`→Gemini, `complex`→`claude -p` - with a per-tier fallback chain (degrades to whatever is configured; never queue-and-hangs on a 429) and a `brain_calls` log (task class, provider, latency, fell-back, error). `POST /api/assistant/ask` (Phase D) now routes through it; with no provider configured it returns an honest "not wired up" reply and `dump` returns `formatted:false` (deterministic pass-through). System prompts are versioned `.md` files under `server/lib/brain/prompts/`.

**Project pulse** (Phase G2) - the working/neglected/completed tracker, recomputed daily via a `registerRecurringTask` on the shared Phase-L scheduler (not a second scheduler):

```
GET    /api/projects/pulse                 Current per-project pulse → { items[], neglectDays }
POST   /api/projects/pulse/recompute       Force an immediate recompute → { items[], neglectDays }
```

Pulse is **deterministic** (not model-generated): state is derived from last session/run/chat/**note** activity vs. `JARVIS_NEGLECT_DAYS` (default 7) + open `- [ ]` todos + the project's status. It renders on the Projects grid, the project detail, and (`GET /api/projects/:id` now also returns a `pulse` field).

### Skills - tap-to-run automations (Phase H)

Skills are **markdown files with YAML frontmatter on disk** (default `~/JarvisSkills`; override with the `JARVIS_SKILLS_DIR` env var or `PUT /api/skills/config`) - same file-first philosophy as Notes, but with no SQLite index (the library is read straight off disk on every request). Backed by `server/lib/skills/store.js` (definitions), `server/lib/skills/engine.js` (execution), and `server/routes/skills.js`. Because running a skill can spawn shell/agent processes, this router reuses the Run router's loopback-Origin guard - the same posture as `/api/run` and `/api/schedules`.

```
GET    /api/skills                         List every skill definition → { items[] }
GET    /api/skills/:id                     Get one skill, with its raw file contents → { skill }
POST   /api/skills                         Create - Body: { raw } (raw markdown+frontmatter) → { skill }
PUT    /api/skills/:id                      Update - Body: { raw } → { skill }
DELETE /api/skills/:id                      Delete (removes the file) → { ok }
GET    /api/skills/config                  { dir, default }
PUT    /api/skills/config                  Set skills dir - Body: { dir } → { dir, default }
POST   /api/skills/:id/run                 Execute - Body: { params?, confirmText? } → { run }
                                             409 ECONFIRM if a typed/tap confirm is missing or wrong,
                                             or a voice/phone/schedule trigger targets anything but confirm:none
GET    /api/skills/runs                    Run history - ?skillId= → { items[] }
GET    /api/skills/runs/:id                One run, with live per-step progress → { run }
POST   /api/skills/runs/:id/cancel         Cancel a running skill → { ok }
```

A skill definition (parsed frontmatter):

```json
{
  "id": "daily-briefing",
  "path": "/Users/you/JarvisSkills/daily-briefing.md",
  "name": "Daily Briefing",
  "icon": "sun",
  "description": "Compose a short morning briefing and push it.",
  "confirm": "none",
  "schedule": "0 7 * * *",
  "params": [],
  "steps": [{ "type": "brain", "taskClass": "standard", "prompt": "..." }, { "type": "notify", "message": "{brain_output}" }],
  "valid": true,
  "errors": []
}
```

**Step types**: `shell` (`command`, `cwd?`, `timeout?` seconds - runs `execFile("/bin/sh", ["-c", command])`; this is intentional local code execution, not a bug), `agent` (`prompt`, `provider?`, `cwd?`, `wait?` - spawns a headless run via `run-spawner`; `wait:false`, the default, doesn't block the skill run on the spawned run's completion), `brain` (`prompt`, `taskClass?`), `notify` (`message`, `title?`, `category?` - a push), `phone` (`shortcut`, `message?` - a push deep-linked to `/skills?phoneRun=<runId>`, where the client renders a `shortcuts://run-shortcut?name=…` hand-off link; iOS gives no way to fire a Shortcut directly from a background push). Step outputs interpolate into later steps' templated fields as `{stepN_output}` / `{<type>_output}`.

**Safety model**: `confirm` is `none` (any trigger - tap, voice, phone, or its own cron `schedule`), `tap` (a human must tap Run - the default for an unset/invalid value), or `typed` (the caller must send `confirmText` matching the skill's name exactly). A `voice`/`phone`/`schedule` trigger can **only ever** fire a `confirm: none` skill, enforced server-side in `server/lib/skills/engine.js` regardless of what `confirmText` is sent.

A skill run:

```json
{
  "id": "b3f...",
  "skill_id": "daily-briefing",
  "skill_name": "Daily Briefing",
  "trigger": "schedule",
  "status": "success",
  "params": {},
  "steps": [
    { "index": 0, "type": "brain", "label": "Brain (standard): ...", "status": "success", "output": "...", "error": null, "startedAt": "...", "finishedAt": "..." },
    { "index": 1, "type": "notify", "label": "Notify: {brain_output}", "status": "success", "output": "...", "error": null, "startedAt": "...", "finishedAt": "..." }
  ],
  "error": null,
  "started_at": "2026-07-04T07:00:00.000Z",
  "finished_at": "2026-07-04T07:00:02.500Z"
}
```

A skill's optional `schedule` (5-field cron) is checked once a minute by a small matcher (`server/lib/skills/cron.js`) ticking on the **shared Phase-L scheduler** - not a second scheduler. Voice: `POST /api/assistant/ask` with `"run skill <name>"` matches by name and runs a `confirm: none` skill with `trigger:"voice"`; anything requiring more confirmation gets an honest spoken refusal instead of running.

---

### GitHub - dev-workflow panel (Phase I)

```
GET  /api/github          Cached cross-repo overview → { overview, fetchedAt, error, mode, configured }
POST /api/github/refresh  Force a live poll now (spawns gh / hits REST) → same shape
GET  /api/github/config   Redacted config → { config: { enabled, hasPat, repos, pollMinutes } }
PUT  /api/github/config   Update config - Body: { enabled?, pat?, repos?, pollMinutes? } → redacted config
```

`mode` is `"gh"` (the locally-authenticated `gh` CLI - recommended, provides per-PR CI rollup), `"pat"` (a server-side Personal Access Token via the REST API - portable, but `ci` is reported as `"unknown"` since per-PR checks aren't fetched in this mode), or `"none"` (neither available → an empty `configured:false` overview). The PAT is stored server-side (env `GITHUB_PAT` or `server/config/github.json`, gitignored) and **never** returned - only a `hasPat` boolean. `repos` is an `owner/name` list.

`overview` shape:

```json
{
  "configured": true,
  "mode": "gh",
  "me": "octocat",
  "repos": ["owner/name"],
  "counts": { "reviewRequested": 2, "mine": 1, "failingChecks": 1, "openIssues": 3 },
  "reviewRequested": [
    { "repo": "owner/name", "number": 42, "title": "Fix bug", "url": "https://…", "author": "bob",
      "updatedAt": "2026-07-04T…", "isDraft": false, "reviewDecision": null, "ci": "failure" }
  ],
  "mine": [ /* GitHubPr[] */ ],
  "issues": [ { "repo": "owner/name", "number": 7, "title": "…", "url": "https://…", "author": "carol", "updatedAt": "2026-07-04T…" } ],
  "latest": [
    { "repo": "owner/name", "branch": "main", "message": "Merge pull request #9 from owner/hotfix",
      "isMerge": true, "mergedPr": { "number": 9, "fromRef": "owner/hotfix", "title": "Hotfix the thing" },
      "author": "carol", "date": "2026-07-04T…", "url": "https://…" }
  ],
  "error": null
}
```

`ci` ∈ `success | failure | pending | none | unknown`. `latest` is the most recent commit on each repo's **default branch** - one entry per repo (skipped, not failed, if that repo's fetch errors), newest-first. It surfaces `branch` + `message` (the commit subject, never the raw SHA - `url` links to the commit for anyone who wants that); when the commit is a merge in GitHub's default "Merge pull request #N from owner/branch" format, `isMerge` is `true` and `mergedPr` carries the PR number, source branch, and (when present on the following body line) its title. The server polls on the shared Phase-L scheduler (cadence = `pollMinutes`), caches a single-row snapshot in `github_cache`, and broadcasts `github_updated` only when the fingerprint changes (now including `latest`); a newly-requested review or newly-red check fires the `github` push category. Like `/api/run`, the router sits behind the loopback-Origin guard (`/refresh` spawns `gh`, `/config` writes a secret).

### Briefings - proactive Jarvis (Phase J)

```
GET  /api/briefings          Recent briefings + latest per kind → { items: Briefing[], latest: { morning, evening } }
POST /api/briefings/run       Compose + persist + push now - Body: { kind: "morning"|"evening" } → { briefing }
GET  /api/briefings/config    Combined Phase-J config → { config: { morning, evening, nudges, persona } }
PUT  /api/briefings/config    Patch any of { morning, evening, nudges, persona } → updated config
```

A `Briefing` is `{ id, kind, trigger, text, speech, provider, note_id, created_at }`. `trigger` ∈ `schedule | manual | voice`; `provider` is the brain provider that composed the prose, or `null` when it fell back to the deterministic (no-model) composition. `speech` is the short, markdown-free, Siri-readable variant.

The **briefing** is composed from state earlier phases already produce - project pulse (Phase G2), the GitHub overview (Phase I), dashboard-run activity since midnight, and agents waiting on the user. Context assembly is deterministic; the prose is written by the brain (standard tier, in Jarvis's persona) when a provider is configured, else composed deterministically from the same facts (nothing is ever invented). Each briefing is filed as a markdown note (`source: briefing`), pushed under the `briefings` category, and broadcast as `briefing_created`. Two scheduled ticks (morning/evening, times in the config) run on the shared Phase-L scheduler; the `POST /run` action and the "morning briefing" voice intent (`POST /api/assistant/ask`) trigger it on demand. The router sits behind the loopback-Origin guard (composing writes notes + fires pushes).

`config` fields:

```json
{
  "morning": { "enabled": true, "time": "07:00" },
  "evening": { "enabled": true, "time": "18:00" },
  "nudges":  { "runFailed": true, "waitingAgents": true, "waitingMinutes": 10 },
  "persona": true
}
```

**Nudges** are deterministic (never model-composed): a failed run fires a `run_completions` push (deep-linked to the run); an agent waiting longer than `waitingMinutes` fires a `waiting_agents` push (deep-linked to its session, once per waiting spell). Neglected projects are *not* instant-pushed - they surface in briefings. All nudges respect the C3 push-category toggles. **`persona`** is the JARVIS personality toggle (dry, formal-but-warm butler voice that addresses the user as "sir"); it applies to the assistant/chat replies, the briefings, and the nudge push copy, and reverts everything to neutral phrasing when off.

---

## WebSocket API

### Connection

```javascript
const ws = new WebSocket('ws://localhost:4820/ws');

ws.onopen = () => {
  console.log('Connected to Agent Dashboard');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected');
};
```

When `DASHBOARD_TOKEN` is configured, pass the token as `?token=<token>` on the `/ws` upgrade (an `x-dashboard-token` header also works):

```javascript
const ws = new WebSocket('ws://localhost:4820/ws?token=YOUR_DASHBOARD_TOKEN');
```

### WebSocket Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Connecting: new WebSocket()
    Connecting --> Connected: onopen
    Connecting --> Disconnected: onerror
    
    Connected --> Connected: onmessage
    Connected --> Disconnected: onclose
    Connected --> Disconnected: onerror
    
    Disconnected --> Connecting: Reconnect
    Disconnected --> [*]
    
    note right of Connected
        Heartbeat: ping every 30s
        Broadcast: Real-time events
    end note
```

### Event Types

Server broadcasts JSON messages to all connected clients:

#### session.created

Sent when a new session is created.

```json
{
  "type": "session.created",
  "data": {
    "id": 1,
    "session_id": "sess_abc123",
    "model": "claude-sonnet-4",
    "status": "active",
    "total_cost": 0,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T12:00:00Z"
  }
}
```

#### session.updated

Sent when session data changes (status, cost, etc.).

```json
{
  "type": "session.updated",
  "data": {
    "id": 1,
    "session_id": "sess_abc123",
    "model": "claude-sonnet-4",
    "status": "completed",
    "total_cost": 1.23,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T14:30:00Z"
  }
}
```

#### agent.created

Sent when a new agent starts.

```json
{
  "type": "agent.created",
  "data": {
    "id": 1,
    "agent_id": "agent_xyz789",
    "session_id": "sess_abc123",
    "agent_type": "explore",
    "status": "running",
    "current_tool": null,
    "input_tokens": 0,
    "output_tokens": 0,
    "cost": 0,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T12:00:00Z"
  }
}
```

#### agent.updated

Sent when agent data changes (tokens, status, current_tool).

```json
{
  "type": "agent.updated",
  "data": {
    "id": 1,
    "agent_id": "agent_xyz789",
    "session_id": "sess_abc123",
    "agent_type": "explore",
    "status": "completed",
    "current_tool": null,
    "input_tokens": 1500,
    "output_tokens": 800,
    "cost": 0.45,
    "created_at": "2024-03-18T12:00:00Z",
    "updated_at": "2024-03-18T12:05:00Z"
  }
}
```

#### tool.executed

Sent when a tool execution completes.

```json
{
  "type": "tool.executed",
  "data": {
    "id": 1,
    "agent_id": "agent_xyz789",
    "tool_name": "bash",
    "duration_ms": 1234,
    "success": 1,
    "error_message": null,
    "created_at": "2024-03-18T12:01:00Z"
  }
}
```

#### notification.received

Sent when a notification is created.

```json
{
  "type": "notification.received",
  "data": {
    "id": 1,
    "session_id": "sess_abc123",
    "notification_type": "backgroundTaskComplete",
    "message": "Explore agent completed",
    "created_at": "2024-03-18T12:05:00Z"
  }
}
```

#### run_stream / run_status / run_input_ack

Broadcast by `routes/run.js` and `lib/run-spawner.js` for `/run` page subprocesses. `run_stream.data.envelope` is a parsed stream-json envelope; the spawner runs claude with `--include-partial-messages` so this includes `stream_event` deltas (`message_start`, `content_block_delta` text/thinking deltas, `message_stop`, etc.) for character-level streaming.

```json
{ "type": "run_stream", "data": { "id": "<run-id>", "envelope": { "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hello" } } } } }
{ "type": "run_status", "data": { "id": "<run-id>", "status": "running", "at": 1700000000000 } }
{ "type": "run_input_ack", "data": { "id": "<run-id>", "messageId": "<uuid>", "at": 1700000000000 } }
```

#### permission_request / permission_resolved

Broadcast by `lib/run-spawner.js` for `permissionUx:"interactive"` runs. `permission_request` fires once per tool call when the PreToolUse gate hook (`scripts/permission-gate.js`) opens a request; `permission_resolved` fires when the dashboard UI (or the request's TTL) settles it. Both carry the same `request` shape - `status` flips `"pending"` → `"resolved"` and `decision`/`reason`/`resolvedAt` populate.

```json
{ "type": "permission_request", "data": { "id": "<run-id>", "request": { "requestId": "toolu_01Ab", "toolName": "Bash", "toolInput": { "command": "npm test" }, "status": "pending", "decision": null, "reason": null, "openedAt": 1700000000000, "resolvedAt": null } } }
{ "type": "permission_resolved", "data": { "id": "<run-id>", "request": { "requestId": "toolu_01Ab", "toolName": "Bash", "toolInput": { "command": "npm test" }, "status": "resolved", "decision": "allow", "reason": null, "openedAt": 1700000000000, "resolvedAt": 1700000004000 } } }
```

#### cc_config_changed

Broadcast whenever Claude Code configuration changes - either by dashboard mutations on `PUT/DELETE /api/cc-config/file` (`source: "dashboard"`) or by `lib/cc-watcher.js` picking up external `fs.watch` events on `~/.claude/` and `~/.claude.json` (`source: "fs"`, debounced at 500 ms). The Config Explorer page subscribes and refetches automatically.

```json
{ "type": "cc_config_changed", "data": { "source": "dashboard", "action": "write", "scope": "user", "type": "skill", "name": "my-skill" } }
{ "type": "cc_config_changed", "data": { "source": "fs", "paths": ["/Users/foo/.claude/settings.json"] } }
```

#### account_swapped

Broadcast by `lib/claude-swap.js` (Phase K) when the observed active claude-swap account changes. The Dashboard's AccountsStrip refetches `GET /api/accounts` on it.

```json
{ "type": "account_swapped", "data": { "from": "acct1@example.com", "to": "acct2@example.com", "reason": "watch", "at": "2026-07-04T15:00:00.000Z" } }
```

#### schedule_created / schedule_updated / schedule_cancelled / schedule_fired / schedule_failed

Broadcast by `lib/scheduler.js` (Phase L) on the lifecycle of a scheduled/chained prompt. `data` is the full `scheduled_prompts` row. The Scheduled page subscribes and refetches; `schedule_fired`/`schedule_failed` also fire a `scheduled_prompts`-category push.

```json
{ "type": "schedule_fired", "data": { "id": "…", "prompt": "…", "status": "fired", "result_run_id": "…", "late": 0 } }
```

#### skill_run_started / skill_run_step / skill_run_finished / skill_run_failed

Broadcast by `lib/skills/engine.js` (Phase H) as a skill run progresses. `data` is the full `skill_runs` row (including the live `steps[]` array) - the Skills page subscribes and refetches; `skill_run_finished`/`skill_run_failed` also fire a `skills`-category push.

```json
{ "type": "skill_run_step", "data": { "id": "…", "skill_id": "daily-briefing", "status": "running", "steps": [{ "index": 0, "type": "brain", "status": "success", "output": "…" }, { "index": 1, "type": "notify", "status": "running" }] } }
```

#### skill_changed

Broadcast by `lib/skills/store.js`'s watcher when a skill file is added/edited/removed on disk. `data` is just `{ at }` - there's no index to diff, so the Skills page simply refetches the whole library.

#### github_updated

Broadcast by `lib/github/service.js` (Phase I) after a poll whose fingerprint changed. `data` is the full `overview` object (see `GET /api/github` above). The GitHub page + the home widget subscribe and refetch. A newly-requested review or newly-red check additionally fires the `github` push category.

#### briefing_created

Broadcast by `lib/briefings.js` (Phase J) whenever a briefing is composed - by a scheduled tick, the `POST /api/briefings/run` action, or the "morning briefing" voice intent. `data` is the `Briefing` row. The Briefings page subscribes and refetches.

### Event Flow

```mermaid
sequenceDiagram
    participant Hook as Hook Handler
    participant Server as Express Server
    participant DB as SQLite
    participant WS as WebSocket Server
    participant Client1 as Client 1
    participant Client2 as Client 2
    
    Hook->>Server: POST /hooks/post-tool-use
    Server->>DB: Create tool_execution
    DB-->>Server: Inserted row
    Server->>WS: broadcast({ type: 'tool.executed', data })
    
    par Broadcast to all clients
        WS->>Client1: { type: 'tool.executed', ... }
        WS->>Client2: { type: 'tool.executed', ... }
    end
    
    Server-->>Hook: 200 OK
```

---

## Error Handling

### Error Response Format

All error responses follow this structure:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {
    "field": "Additional context"
  }
}
```

### HTTP Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | Success | Resource retrieved |
| 201 | Created | Resource created |
| 400 | Bad Request | Invalid JSON, missing fields |
| 404 | Not Found | Session/agent not found |
| 409 | Conflict | Duplicate pattern |
| 500 | Server Error | Database error |

### Error Examples

**400 Bad Request:**

```json
{
  "error": "Missing required field: pattern",
  "code": "VALIDATION_ERROR",
  "details": {
    "field": "pattern",
    "message": "Pattern is required"
  }
}
```

**404 Not Found:**

```json
{
  "error": "Session not found",
  "code": "NOT_FOUND",
  "details": {
    "session_id": "sess_invalid"
  }
}
```

**409 Conflict:**

```json
{
  "error": "Pricing rule already exists",
  "code": "DUPLICATE_PATTERN",
  "details": {
    "pattern": "claude-sonnet-4"
  }
}
```

---

## Rate Limiting

Currently, no rate limiting is enforced. For production deployments, implement rate limiting:

```javascript
// Using express-rate-limit
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.'
});

app.use('/api/', limiter);
```

---

## Pagination

For endpoints returning lists, use `limit` and `offset`:

```http
GET /api/sessions?limit=20&offset=40
```

**Pagination Pattern:**

```mermaid
graph LR
    Page1[Page 1<br/>offset=0<br/>limit=20] --> Page2[Page 2<br/>offset=20<br/>limit=20]
    Page2 --> Page3[Page 3<br/>offset=40<br/>limit=20]
    Page3 --> PageN[Page N<br/>offset=N*20<br/>limit=20]
    
    style Page1 fill:#3B82F6
```

**Response includes pagination metadata:**

```json
{
  "sessions": [...],
  "total": 156,
  "limit": 20,
  "offset": 40,
  "has_more": true
}
```

---

## Examples

### Full Session Workflow

```javascript
// 1. List sessions
const sessions = await fetch('http://localhost:4820/api/sessions');
const { sessions: sessionList } = await sessions.json();

// 2. Get specific session
const sessionId = sessionList[0].session_id;
const session = await fetch(`http://localhost:4820/api/sessions/${sessionId}`);
const sessionData = await session.json();

// 3. Get session agents
const agents = await fetch(`http://localhost:4820/api/sessions/${sessionId}/agents`);
const { agents: agentList } = await agents.json();

// 4. Get agent tools
const agentId = agentList[0].agent_id;
const tools = await fetch(`http://localhost:4820/api/agents/${agentId}/tools`);
const { tools: toolList } = await tools.json();

console.log('Session:', sessionData);
console.log('Agents:', agentList);
console.log('Tools:', toolList);
```

### Real-time Monitoring

```javascript
// Connect to WebSocket
const ws = new WebSocket('ws://localhost:4820/ws');

ws.onopen = () => {
  console.log('Connected to real-time stream');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'session.created':
      console.log('New session:', message.data.session_id);
      break;
    
    case 'agent.updated':
      console.log('Agent updated:', message.data.agent_id);
      console.log('Cost:', message.data.cost);
      break;
    
    case 'tool.executed':
      console.log('Tool executed:', message.data.tool_name);
      console.log('Duration:', message.data.duration_ms, 'ms');
      break;
  }
};
```

### Creating Pricing Rules

```javascript
// Create custom rule
const response = await fetch('http://localhost:4820/api/pricing', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pattern: 'my-custom-model',
    input_cost_per_1m: 5.0,
    output_cost_per_1m: 20.0
  })
});

const { rule } = await response.json();
console.log('Created rule:', rule);

// List all rules
const rules = await fetch('http://localhost:4820/api/pricing');
const { rules: ruleList } = await rules.json();
console.log('All rules:', ruleList);

// Delete rule
await fetch('http://localhost:4820/api/pricing/my-custom-model', {
  method: 'DELETE'
});
```

---

## Summary

The Agent Dashboard API provides:

- ✅ **RESTful endpoints** for querying sessions, agents, tools, pricing
- ✅ **WebSocket streaming** for real-time updates
- ✅ **Type-safe responses** with consistent JSON structure
- ✅ **Error handling** with descriptive error codes
- ✅ **Pagination** for large datasets
- ✅ **Pricing management** with custom rule support

For interactive API exploration with live request/response examples, see the built-in Swagger UI at `/api/docs` and ReDoc at `/api/redoc`. For MCP integration, see [MCP.md](./MCP.md).
