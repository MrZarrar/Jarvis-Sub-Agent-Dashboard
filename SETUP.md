# Jarvis setup

This is the supported setup for the personal Windows development checkout. Jarvis runs directly on the host so it can use the signed-in Codex and Claude Code CLIs, local project files, and the Markdown vault.

## Requirements

- Windows 11
- Git
- Node.js 22 and npm
- GitHub CLI (`gh`)
- Codex CLI signed in to the personal ChatGPT account
- Claude Code signed in to the authorised Claude account
- Tailscale only when private remote access is needed

Use PowerShell from the repository root. If PowerShell blocks the `npm.ps1` shim, use `npm.cmd`, as shown below.

## Install

```powershell
git clone https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard.git
Set-Location .\Jarvis-Sub-Agent-Dashboard
npm.cmd run setup
```

`setup` installs the root, client, and VS Code extension dependencies. It also configures this checkout's Git hooks.

Confirm the authenticated tools without printing credentials:

```powershell
gh auth status
codex --version
claude --version
```

## Local data boundaries

Jarvis deliberately separates operational state from portable knowledge.

| Data | Default Windows location | Rule |
| --- | --- | --- |
| Operational SQLite and snapshots | `%USERPROFILE%\.claude\agent-dashboard\` | Keep local; do not place SQLite, WAL, or SHM files in iCloud/OneDrive |
| Markdown vault | `%USERPROFILE%\JarvisNotes\` | Portable source of truth for personal knowledge |
| Business Markdown workspace | `%USERPROFILE%\JarvisBusiness\` | Optional; create only when business setup begins |
| Provider configuration | `server\config\*.json` | Local and Git-ignored; never commit credentials |
| Source code | This Git checkout | GitHub is the source of truth |

The current migration phase uses a disposable personal-PC development database. It is not the future company-core production database.

## Configuration

Copy the example only when you need overrides:

```powershell
Copy-Item .env.example .env
```

The server reads `.env` automatically. Useful settings are:

```dotenv
DASHBOARD_PORT=4820
DASHBOARD_HOST=127.0.0.1
DASHBOARD_DATA_DIR=C:/Users/your-name/AppData/Local/Jarvis/development
JARVIS_NOTES_DIR=C:/Users/your-name/JarvisNotes
JARVIS_BUSINESS_DIR=C:/Users/your-name/JarvisBusiness
```

`DASHBOARD_DB_PATH` may point to one exact database file. Otherwise Jarvis creates `dashboard.db` inside `DASHBOARD_DATA_DIR`. Keep either location outside the repository and outside synced storage.

Jarvis defaults to signed-in subscription routes:

- Codex owns generic, personal, business, and mission work.
- Claude Code is the development execution lane and a Mini Jarvis fallback.
- No OpenAI or Anthropic API key is required.
- Legacy API/local-model adapters remain dormant compatibility code and are not default routing.

## Run locally

Development mode starts the API and Vite client together:

```powershell
npm.cmd run dev
```

- API: `http://localhost:4820` by default
- Vite client: `http://localhost:5173`
- If 4820 is busy, the development launcher chooses the next free port and prints it.

Production-style local run:

```powershell
npm.cmd run build
npm.cmd start
```

Open `http://localhost:4820`. The production server serves `client\dist`, so rebuild after client changes.

## Claude Code hooks

When Jarvis runs directly on the host, it installs and maintains its Claude Code hook entries while preserving unrelated hooks. To reinstall them explicitly:

```powershell
npm.cmd run install-hooks
```

Start a new Claude Code session after hook installation. Existing session history is discovered from the configured `CLAUDE_HOME` and imported without modifying the source transcripts.

## Codex lifecycle

Jarvis uses the signed-in Codex CLI and a managed `codex app-server` process for durable missions. The mission surface supports start, resume, steer, interrupt, fork, archive, approvals, and streamed events. Provider failures remain visible; Jarvis does not silently cross into API billing.

## Notes and business mode

`JARVIS_NOTES_DIR` points to an Obsidian-compatible Markdown vault. Jarvis writes through guarded vault actions and keeps its operational index in SQLite.

Business mode is a separate view over business-tagged daily work and the optional `JARVIS_BUSINESS_DIR`. eBay, Amazon, Keepa, and SellerAmp settings are dormant until explicitly enabled and configured. Saving credentials does not enable purchasing, publishing, messaging, or financial actions.

## Verification

Run the checks that match your change:

```powershell
npm.cmd run test:server
npm.cmd run test:client
npm.cmd run test:mcp
npm.cmd run mcp:typecheck
npm.cmd run mcp:build
npm.cmd run build
```

Health check after starting Jarvis:

```powershell
Invoke-RestMethod http://localhost:4820/api/health
```

## Private remote access

Keep Jarvis loopback-only until remote access is deliberately configured. The preferred later deployment is HTTPS through Tailscale with `DASHBOARD_TOKEN`; never expose port 4820 directly to the public internet. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Troubleshooting

### `npm` is blocked by PowerShell

Use `npm.cmd` instead of `npm`.

### Port 4820 is already in use

Check whether another Jarvis server or desktop build is already running. Development mode can choose another port, but two servers sharing one database can double-ingest hook events.

### SQLite cannot load

Use Node.js 22. If `better-sqlite3` still needs a native build, install the Windows C++ build tools and run:

```powershell
npm.cmd rebuild better-sqlite3
```

### Sessions do not appear

Restart Jarvis, run `npm.cmd run install-hooks`, then start a new Claude Code session. Confirm `CLAUDE_HOME` only if the CLI uses a non-default home.

### Codex or Claude is unavailable

Run `codex --version` or `claude --version`, then complete that CLI's interactive sign-in. Do not add an API key as an automatic workaround.

### Remote browser says `host not allowed`

Use the HTTPS Tailscale route described in [DEPLOYMENT.md](DEPLOYMENT.md), or add only the exact trusted hostname to `DASHBOARD_ALLOWED_HOSTS` when using a direct tailnet bind.
