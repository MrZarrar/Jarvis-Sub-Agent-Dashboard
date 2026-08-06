# Agentic OS operations

Jarvis exposes one Command Center at `/missions` for generic, personal, business, and development work. The dashboard and Ops Room summarize active missions, approvals, blockers, outcomes, schedules, and runtime health.

## Provider policy

| Lane | Owner | Worker | Access |
| --- | --- | --- | --- |
| Generic | Codex | Codex | Signed-in ChatGPT/Codex subscription |
| Personal | Codex | Codex personal roles | Signed-in ChatGPT/Codex subscription |
| Business | Codex | Codex business roles | Signed-in ChatGPT/Codex subscription |
| Development | GPT-5.6 Sol mission owner | Claude Code crew | Signed-in Codex and Claude subscriptions |

Mini Jarvis routes simple and standard work to Codex then Claude, and complex work to Claude then Codex. No default route uses OpenAI or Anthropic API billing. Legacy API and local-model adapters are disabled compatibility code, not automatic fallbacks.

An unavailable required provider fails visibly. Provider and model identity remain attached to mission events.

## Lifecycle

Codex missions use the managed app-server supervisor and persist their native thread ID. Jarvis reconnects active threads after restart. Start, resume, steer, interrupt, retry, fork, archive, streamed events, artifacts, questions, and approvals use the same mission API on desktop and mobile.

Development work follows one ownership chain:

1. Sol owns the objective and produces a bounded brief.
2. Claude Code executes through Scout, Forge, Sentinel, and Ops when useful.
3. Hooks and transcripts return evidence to the Jarvis mission timeline.
4. Sol reconciles the result and remains accountable for closure.

Sol may use at most four direct children at depth one.

## Permissions

All dynamic tools use the shared Jarvis action registry. Confirm-risk actions require interactive approval. Typed-risk actions require the action name. Scheduled and other non-interactive sources can run only actions already classified as safe.

Pairing codes are returned only to the requesting client and are not persisted or logged. Provider credentials stay in the supported CLI credential store or local Git-ignored configuration.

## Scheduling

Scheduled missions support one-time and recurring execution, new or resumed threads, overlap policy, missed-run handling, launch retries, timeout, notifications, and an explicit sandbox. Read-only is the default. A schedule cannot broaden approval policy.

## Remote

Codex Remote uses supported Codex CLI commands and official handoff surfaces. Jarvis remote access is a separate network boundary: use authenticated Tailscale HTTPS and do not expose port 4820 publicly.

## Feature flags and kill switches

Default-on rollout flags:

- `JARVIS_FEATURE_CODEX_KERNEL`
- `JARVIS_FEATURE_UNIFIED_MISSIONS`
- `JARVIS_FEATURE_MOBILE_CODEX_REMOTE`
- `JARVIS_FEATURE_CODEX_SCHEDULES`

Provider kill switches use `JARVIS_PROVIDER_<PROVIDER>_DISABLED=1`, including `JARVIS_PROVIDER_CODEX_DISABLED` and `JARVIS_PROVIDER_CLAUDE_CODE_DISABLED`. Disabling a provider never silently selects a paid API alternative.

## Diagnostics

Primary surfaces:

- `/api/missions` and lifecycle subroutes
- `/api/providers/capabilities`
- `/api/codex/remote/status|start|stop|pair`
- `/api/schedules`
- `/api/health`

WebSocket clients consume redacted `mission.event` and `mission.delta` envelopes. Pinned Codex protocol schemas live under `server/schemas`; upgrades require a reviewed schema diff and fixture tests.

## Validation and rollback

Run server, client, MCP, and production-build checks before a migration gate. Database migrations are additive. Back up SQLite with a consistent SQLite backup while Jarvis is stopped, and keep the Markdown vault backup separate. See [DEPLOYMENT.md](../DEPLOYMENT.md).
