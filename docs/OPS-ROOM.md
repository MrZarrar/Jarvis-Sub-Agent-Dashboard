# Ops Room — Team, Delegation & Models

The Ops Room (`client/src/components/AgentRoom.tsx`) is a pixel-art office
staffed by a fixed crew of five characters. It is purely presentational — it
renders the agents the dashboard already tracks — but the crew is also **real**:
each teammate has a matching agent definition in `.claude/agents/` that Claude
Code delegates to by name, pinned to its own model.

## The crew

| Teammate | Character     | Role                | Agent file                  | Model  |
|----------|---------------|---------------------|-----------------------------|--------|
| Jarvis   | Robot         | Mission owner / orchestrator | Codex mission thread | GPT-5.6 Sol |
| Scout    | Sherlock      | Recon: search, read, web research | `.claude/agents/scout.md`    | Claude Haiku |
| Forge    | Code Monkey   | Implementation: edits, new code   | `.claude/agents/forge.md`    | Claude Sonnet |
| Sentinel | Caped vigilante | Review: bugs, contracts, integrity | `.claude/agents/sentinel.md` | Claude Opus |
| Ops      | Ninja         | Terminal: builds, tests, commands | `.claude/agents/ops.md`      | Claude Haiku |

GPT-5.6 Sol owns the mission and produces the execution brief. Cheap,
high-volume Claude work (recon and command running) uses Haiku; code writing
uses Sonnet; review depth uses Opus. Change a
teammate's model by editing the
`model:` frontmatter in its agent file — and keep the `model` label in the
`TEAM` array in `AgentRoom.tsx` in sync so the chips stay honest.

To make the crew available in **every** project (not just this repo), copy the
four agent files into `~/.claude/agents/`.

## How delegation flows

1. GPT-5.6 Sol inspects the mission and writes a bounded execution brief.
2. The Claude Code team lead executes that brief and delegates through the
   Task tool to Scout, Forge, Sentinel, and Ops when useful.
3. The hooks pipeline reports the spawned Claude agents to the dashboard.
4. The Ops Room routes each live agent to a desk **by name first**
   (`subagent_type`/name matching scout/forge/sentinel/ops and friendly
   aliases like sherlock/monkey/reviewer), then by the tool in hand.
5. The `#ops-room` panel narrates delegations as `@Scout — <task description> 📋`
   and completions as the teammate handing back to Jarvis.
6. GPT-5.6 Sol reviews the Claude team result and closes the mission.

## Off duty

Teammates with no assigned work goof off: arcade cabinet (🎮), dancing by the
boombox on the rug (♪), couch naps (💤), coffee (☕), and water-cooler chat (…).
All canvas-side only; `prefers-reduced-motion` renders a static scene.

## Other models and providers

- **Gemini / Ollama (qwen etc.)** — external models can't be Task subagents,
  so they route through the existing multi-provider surfaces instead: the
  brain router's tiers (`server/lib/brain/router.js`) and the Run page's
  provider picker (`server/lib/providers/agent/`). Point the simple/standard
  tiers at ollama (e.g. a qwen model) or gemini in Settings → providers.
- **Codex** — lands with v3 phase AB (`PLAN-jarvis-v3.md`); once `codex exec`
  runs surface in the dashboard, they'll route to desks the same way.
- **Ruflo swarms (optional)** — for heavier orchestration (swarm topologies,
  shared agent memory, 100+ prebuilt agents), register
  [ruflo](https://github.com/ruvnet/ruflo) as an MCP server:
  `claude mcp add ruflo -- npx ruflo@latest mcp start`
  (or `/plugin install ruflo-core@ruflo`). Its spawned agents appear in the
  dashboard via the same hooks pipeline; anything named scout/forge/etc.
  lands on the matching desk. Not installed by default — it's a large
  third-party framework, opt in deliberately.
