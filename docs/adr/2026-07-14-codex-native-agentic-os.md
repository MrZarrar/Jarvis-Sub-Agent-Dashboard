# ADR: Codex-native Agentic OS

- Status: accepted, amended for the personal-PC migration
- Original date: 2026-07-14
- Amended: 2026-08-06

## Decision

Jarvis is a provider-neutral Agentic OS with Codex as its durable mission kernel. Generic, personal, and business work use the signed-in Codex CLI/app-server. Development missions retain a Codex owner and execute repository work through signed-in Claude Code workers.

Default routing is subscription-only. Mini Jarvis may fall back between Codex and Claude, but Jarvis does not silently convert subscription work into OpenAI, Anthropic, Gemini, Groq, or other API billing. Dormant compatibility adapters do not change this policy.

Sol is reserved for complex ownership and may create at most four direct children at depth one. Development workers are the Claude Code Scout, Forge, Sentinel, and Ops roster. Personal and business workers remain Codex-native.

Markdown in `JarvisNotes` and the optional `JarvisBusiness` workspace is portable state. SQLite is the local operational index and must remain outside synced storage.

## Supported boundaries

- Codex lifecycle uses the pinned `codex app-server` JSON-RPC protocol.
- Claude Code remains the development execution and observability lane.
- Codex Remote uses supported CLI and official handoff behavior; Jarvis does not reverse engineer a relay.
- Jarvis owns schedule authoring until a supported provider API can replace it safely.
- Dynamic tool calls pass through `server/lib/assistant-actions/dispatcher.js`.
- The personal Windows checkout is the development authority after Phase 2, with a disposable development database.

## Rollout and rollback

The default-on feature flags are `JARVIS_FEATURE_CODEX_KERNEL`, `JARVIS_FEATURE_UNIFIED_MISSIONS`, `JARVIS_FEATURE_MOBILE_CODEX_REMOTE`, and `JARVIS_FEATURE_CODEX_SCHEDULES`.

Before rollback or migration, stop Jarvis and make a consistent SQLite backup. On Windows, with `sqlite3` installed:

```powershell
$db = "$env:USERPROFILE\.claude\agent-dashboard\dashboard.db"
sqlite3 $db ".backup '$db.pre-change'"
sqlite3 "$db.pre-change" "PRAGMA integrity_check;"
```

Code rollback and feature flags are the normal recovery path. Restore a database backup only when the database is damaged because restoring it discards newer operational history.

## Consequences

Claude sessions and imported Codex history remain observable. Jarvis owns a small unified mission index while provider-native payloads remain diagnostic and are redacted before client broadcast. The project carries no requirement for Kubernetes, multi-cloud deployment, local-model infrastructure, or paid API fallback.
