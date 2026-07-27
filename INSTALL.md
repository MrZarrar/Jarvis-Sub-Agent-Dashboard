# Installing Jarvis

Jarvis runs as a Node.js server with a React client. Install it directly on the machine that owns the agent CLIs and local data you want Jarvis to use.

## Requirements

- Node.js 18 or newer; Node.js 22 is recommended
- npm 9 or newer
- Git
- Codex and/or Claude Code for the workflows you intend to run

## Install from source

```bash
git clone https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard.git
cd Jarvis-Sub-Agent-Dashboard
npm run setup
```

`npm run setup` installs the root, client, and VS Code extension dependencies.

## Run in development

```bash
npm run dev
```

- API and production-style server: `http://localhost:4820`
- Vite development client: `http://localhost:5173`

## Run the built application

```bash
npm run build
npm start
```

Open `http://localhost:4820`.

## Agent integration

When Jarvis runs directly on the host, the server installs the Claude Code hooks it owns while preserving unrelated hook configuration. You can also run:

```bash
npm run install-hooks
```

Codex workflows use the installed Codex runtime and its signed-in account. Provider-specific setup is available in the Jarvis Settings page and [.env.example](.env.example).

## Import existing history

Jarvis discovers compatible local session data at startup. To trigger an explicit import:

```bash
npm run import-history
```

## Docker

```bash
docker compose up -d --build
```

The Compose route exposes Jarvis only at `http://localhost:4820` and is best for dashboard use. Prefer a direct host install when Jarvis must launch host agent CLIs or access personal files.

## Desktop packaging

The Electron workspace can be built from source:

```bash
npm run build
npm run desktop:install
```

Then use the platform-specific build command:

```bash
npm run desktop:dmg:arm64
npm run desktop:dmg:x64
npm run desktop:win
npm run desktop:win:portable
```

There are no maintained pre-built Jarvis installers yet. See [DESKTOP.md](DESKTOP.md) for the current packaging status.

## Verify the installation

```bash
npm run test:server
npm run test:client
npm run build
curl http://localhost:4820/api/health
```

## Remote access

Jarvis binds to loopback by default. Follow [DEPLOYMENT.md](DEPLOYMENT.md) before enabling Tailscale or any other network access.

## Troubleshooting

- If port 4820 is occupied, stop the existing process or set `DASHBOARD_PORT`.
- If a remote browser receives `host not allowed`, add its exact host or IP to `DASHBOARD_ALLOWED_HOSTS`.
- If agent sessions do not appear, restart Jarvis and install hooks again.
- If native SQLite installation fails, use Node.js 22 with the platform build tools.

The detailed configuration reference remains in [SETUP.md](SETUP.md).
