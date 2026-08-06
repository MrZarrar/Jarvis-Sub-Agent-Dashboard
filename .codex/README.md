# Codex Agent Setup

This directory contains all project-scoped Codex extensions:

- instruction baseline via root [`AGENTS.md`](../AGENTS.md)
- execution policy rules in [`rules/default.rules`](./rules/default.rules)
- custom subagent definitions in [`agents/`](./agents)
- reusable skills in [`skills/`](./skills)
- runtime configuration in [`config.toml`](./config.toml)

## What Codex reads

- `AGENTS.md` from repository root
- `.codex/config.toml` for runtime settings
- `.codex/agents/*.toml` for custom agents
- `.codex/skills/*/SKILL.md` for project skills
- `.codex/rules/*.rules` for execution policy

## Included custom agents

- `sol-supervisor`: complex mission owner with a four-child, depth-one delegation limit
- personal roles: `personal-ops`, `researcher`, and `vault-curator`
- business roles: `deal-scout`, `underwriter`, `listing-writer`, `cs-drafter`,
  `bookkeeper`, and `ops-manager`

Development execution is intentionally owned by the Claude Code crew in
`.claude/agents`: `scout`, `forge`, `sentinel`, and `ops`. Do not duplicate those
workers under `.codex/agents`.

## Included skills

- `repo-onboarding` - architecture discovery and verification selection
- `mcp-maintainer` - MCP server operations and troubleshooting
- `release-guard` - release readiness checks
