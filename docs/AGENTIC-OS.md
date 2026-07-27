# Agentic OS operations

Jarvis exposes one Command Center at `/missions` for Personal, Development, Business, and Generic work. The dashboard home and Ops Room summarize running missions, approval/blockers, latest outcomes, the next scheduled mission, and Codex kernel health.

## Provider and billing policy

| Lane | Owner | Worker | Access |
|---|---|---|---|
| Generic conversation | Groq | Groq | configured metered API quota |
| Generic bounded action | Gemini | Gemini + Jarvis dispatcher | configured metered API quota |
| Personal | Codex | Luna/Terra/Sol | signed-in ChatGPT subscription CLI |
| Business | Codex | Luna/Terra/Sol | signed-in ChatGPT subscription CLI |
| Development | GPT-5.6 Sol | Claude Code team | signed-in ChatGPT and Claude subscription CLIs |

Development runs as a Sol orchestration turn, a bounded Claude Code team execution, then a Sol owner review. There is no OpenAI/Anthropic API fallback. An unavailable required provider fails visibly. Settings → AI Providers reports current capability, models, and access type.

## Lifecycle and permissions

Codex missions use the managed app-server supervisor, persist their native thread ID, and mirror their objective/status through native Codex goals. Jarvis reconnects active threads after restart. Start/resume, steer/continue, interrupt, retry, fork, persistent archive, streamed events, artifacts, and approvals use the same mission API on desktop and mobile. Imported Codex history remains in Sessions unless explicitly requested, so it does not crowd the active command center.

All Codex dynamic tools use the shared action registry. Codex command/file approvals, structured user questions, MCP elicitation, Claude Code worker permissions, and typed-risk Jarvis actions resolve in the same Mission approval card. Confirm-risk actions require an interactive allow; typed-risk actions require the action name. Scheduled/non-interactive calls can only run safe actions. Pairing codes are returned only to the requesting UI and are never stored or logged.

## Scheduling

Scheduled missions support one-time and RRULE minute/hour/day/week recurrence, chaining after another Mission completes, `new_thread`, `resume_thread`, and `steer_active`, overlap (`skip`, `queue`, `cancel_previous`), missed-run handling, launch retries, execution timeout, notifications, and explicit sandbox policy. Read-only is the default; workspace writes must be selected deliberately. Scheduled work never broadens approval policy on its own. Legacy run-completion schedules remain compatible but are no longer the primary UI path.

## Remote

The normal Remote setup is the QR flow in Codex desktop. Jarvis exposes its CLI remote-control host only under an explicitly labelled experimental disclosure, plus a native handoff link when available. Jarvis mobile access continues to use the dashboard's existing authentication and network boundary.

## Feature flags

All are default-on; use `0`, `false`, or `off` to disable:

- `JARVIS_FEATURE_CODEX_KERNEL`
- `JARVIS_FEATURE_UNIFIED_MISSIONS`
- `JARVIS_FEATURE_MOBILE_CODEX_REMOTE`
- `JARVIS_FEATURE_CODEX_SCHEDULES`

Provider kill switches are `JARVIS_PROVIDER_CODEX_DISABLED`, `JARVIS_PROVIDER_CLAUDE_CODE_DISABLED`, `JARVIS_PROVIDER_GROQ_DISABLED`, and `JARVIS_PROVIDER_GEMINI_DISABLED`. A kill switch never changes mission ownership silently.

## Protocol and diagnostics

Pinned schemas live under `server/schemas/codex-0.144.2/`. Regenerate them with the installed Codex binary when deliberately upgrading the protocol, review the diff, update the supervisor version, then rerun the fixture suite. Unknown inbound or outbound methods are rejected and surfaced as protocol errors.

Primary endpoints:

- `/api/missions` and mission lifecycle subroutes
- `/api/providers/capabilities`
- `/api/codex/remote/status|start|stop|pair`
- `/api/schedules`

WebSocket clients consume redacted `mission.event` and `mission.delta` envelopes.

## Validation and rollback

Run `npm run build`, `npm run test:server`, `npm run test:client`, `npm run mcp:typecheck`, and `npm run mcp:build`. Normal CI uses fake transports; paid provider calls are opt-in smoke tests only.

Database changes are additive. Follow the backup and rollback procedure in the [ADR](./adr/2026-07-14-codex-native-agentic-os.md).
