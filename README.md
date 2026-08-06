# Jarvis Agentic OS

Jarvis is a self-hosted command centre for running AI-assisted work across Codex, Claude Code, missions, approvals, schedules, knowledge, and business operations.

It began as a dashboard for observing Claude Code agents. It has since grown into a broader, Codex-native operating layer with its own mission system, provider routing, mobile control surface, second-brain integration, and operational tools.

> **Status:** active personal project. Jarvis is used and developed as a real working system, but it is not yet a polished consumer product.

## What Jarvis does

- **Mission control** - create, route, monitor, review, and resume agent work.
- **Subscription-backed operations** - Codex owns missions and Claude Code executes the development lane without silent API-key billing.
- **Approvals and safety** - keep consequential actions visible and gated.
- **Mobile access** - use the responsive dashboard over a private network such as Tailscale.
- **Second brain** - work with a Markdown knowledge vault without making the dashboard database the source of truth.
- **Schedules and automations** - manage recurring work and operational follow-ups.
- **Observability** - inspect sessions, tool activity, token usage, costs, and system health.
- **Business workspace** - bring projects, integrations, and daily operations into one control surface.

## Architecture

| Layer | Purpose |
| --- | --- |
| React + Vite client | Responsive command centre and visual surfaces |
| Node.js + Express server | API, orchestration, integrations, and WebSocket events |
| SQLite | Local operational state |
| Markdown vault | Portable, human-readable long-term knowledge |
| Codex and Claude Code | Signed-in subscription runtimes |
| MCP and guarded adapters | Bounded tools and optional integrations |

Jarvis is local-first. The server binds to `127.0.0.1` by default. Remote access should be through a trusted private network and protected with `DASHBOARD_TOKEN`; see [Security](.github/SECURITY.md).

## Quick start

### Requirements

- Node.js 22 recommended
- npm 9 or newer
- signed-in Codex CLI
- signed-in Claude Code for development missions

### Development

```bash
git clone https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard.git
cd Jarvis-Sub-Agent-Dashboard
npm run setup
npm run dev
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution policy blocks the PowerShell shim.

The API runs at `http://localhost:4820` and the Vite development client at `http://localhost:5173`.

### Production-style local run

```bash
npm ci
cd client && npm ci && cd ..
npm run build
npm start
```

Open `http://localhost:4820`.

Configuration examples live in [.env.example](.env.example). Never commit provider credentials, dashboard tokens, or personal vault data.

The operational SQLite database is local state; the `JarvisNotes` Markdown vault is portable knowledge. Keep SQLite outside iCloud, OneDrive, and the repository. See [Setup](SETUP.md) and [Architecture](ARCHITECTURE.md).

## Useful commands

```bash
npm run test:server   # server integration tests
npm run test:client   # client tests
npm run test:mcp      # MCP tests
npm run build         # production client build
npm run mcp:build     # build the MCP package
```

## Project layout

```text
client/       React dashboard
server/       API, orchestration, storage, and integrations
mcp/          MCP server
plugins/      agent plugins and skills
desktop/      desktop packaging
scripts/      setup and maintenance utilities
docs/         focused technical documentation
```

## Contributing

Issues and focused pull requests are welcome. Start with the [contribution guide](.github/CONTRIBUTING.md), keep changes scoped, and include tests or screenshots where they help reviewers verify the result.

## Origin and attribution

Jarvis was originally derived from [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) by [Son Nguyen](https://github.com/hoangsonww). The repository deliberately retains that project history and its contributors rather than rewriting or hiding the origin.

The current Jarvis architecture, product direction, and substantial later development are maintained by [Mushaf Zarrar](https://github.com/MrZarrar). Original and subsequent work remain available under the MIT License; see [LICENSE](LICENSE).

## License

MIT. Copyright remains with the respective authors and contributors.
