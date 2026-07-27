# ADR: Codex-native Agentic OS

- Status: accepted
- Date: 2026-07-14

## Decision

Jarvis is a provider-neutral Agentic OS with Codex as its durable mission kernel. Personal and business missions use signed-in Codex CLI/app-server access. Development missions use GPT-5.6 Sol as the accountable owner and orchestrator, execute repository work through signed-in Claude Code workers, then return to Sol for final review. Groq handles low-risk generic conversation, and Gemini handles bounded generic actions through the shared Jarvis permission dispatcher.

The implementation uses one mission envelope, timeline, approval system, scheduler, mobile surface, and audit trail. Provider/model and access labels remain visible. There is no silent provider fallback and no conversion from subscription CLI use to OpenAI or Anthropic API billing.

Sol owns every development mission and other complex execution, with at most four direct roles at depth one. Development roles use Claude Code; other children remain Codex-native. Markdown in `~/JarvisNotes` and `~/JarvisBusiness` remains the portable state of record.

## Supported boundaries

- Codex lifecycle: pinned `codex app-server` JSON-RPC over backend-managed stdio.
- Native Remote: supported `codex remote-control` start/stop/pair commands and a handoff to ChatGPT; no relay reverse engineering.
- Scheduling: Jarvis remains the authoring/control plane until Codex exposes supported schedule CRUD.
- Actions: every dynamic tool call passes through `server/lib/assistant-actions/dispatcher.js`.

## Rollout and rollback

The default-on flags are `JARVIS_FEATURE_CODEX_KERNEL`, `JARVIS_FEATURE_UNIFIED_MISSIONS`, `JARVIS_FEATURE_MOBILE_CODEX_REMOTE`, and `JARVIS_FEATURE_CODEX_SCHEDULES`. Set any to `0`, `false`, or `off` to disable that surface while preserving stored mission history.

Before rollout, stop the dashboard and make a consistent SQLite backup:

```sh
DB="${DASHBOARD_DB_PATH:-$HOME/.claude/agent-dashboard/dashboard.db}"
sqlite3 "$DB" ".backup '$DB.pre-agentic-os'"
sqlite3 "$DB.pre-agentic-os" "PRAGMA integrity_check;"
```

Rollback is code rollback plus feature flags; database migrations are additive. Restore the backup only if the database itself is damaged, because restoring it discards newer mission history.

## Consequences

Existing Claude sessions and Codex rollout imports stay readable. Jarvis gains a small operational index (`missions`, `mission_events`, links, approvals) while provider-native payloads remain diagnostic data and are redacted before WebSocket broadcast.
