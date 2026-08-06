# Ops Room

The Ops Room visualizes Jarvis's real development ownership chain. It is not a separate scheduler or agent runtime.

## Crew

| Teammate | UI character | Responsibility | Definition | Model |
| --- | --- | --- | --- | --- |
| Jarvis | Robot | Mission owner and final reconciliation | Codex mission thread | GPT-5.6 Sol for complex work |
| Scout | Detective | Repository recon and evidence | `.claude/agents/scout.md` | Claude Haiku |
| Forge | Code monkey | Contained implementation | `.claude/agents/forge.md` | Claude Sonnet |
| Sentinel | Caped reviewer | Correctness, integrity, security, and release risk | `.claude/agents/sentinel.md` | Claude Opus |
| Ops | Ninja | Commands, builds, tests, and process checks | `.claude/agents/ops.md` | Claude Haiku |

Development flow:

1. Codex owns the mission objective and creates a bounded execution brief.
2. Claude Code delegates to the four project workers when the work benefits from specialization.
3. Claude hooks and transcripts feed activity back to Jarvis.
4. The Ops Room maps live agents to desks by explicit role/name and then by tool activity.
5. Codex reviews the returned evidence and closes or redirects the mission.

In business mode the same four desks are presented as Deal Scout, Lister, Underwriter, and Bookkeeper. Those are UI aliases for the business surface; authoritative business Codex roles live in `.codex/agents`.

Idle animations are presentation only. They do not create work, spend tokens, or imply that an agent process is running.
