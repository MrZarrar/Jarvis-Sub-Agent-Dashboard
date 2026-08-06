# Deploying Jarvis

Jarvis is a local-first, single-host application. The supported deployment model is one trusted machine running the Node.js server, with browsers connecting locally or over a private network such as Tailscale.

It is not currently designed for public-internet exposure, multiple active server replicas, Kubernetes, or managed cloud databases.

## Choose a route

| Route | Best for |
| --- | --- |
| Direct Node.js process | Primary workstation or an always-on Windows/Linux host |
| Docker Compose | Isolated local deployment when agent CLI execution is not required inside the container |
| Tailscale Serve | Authenticated HTTPS access from a Mac, iPhone, or another trusted device |

## Direct host deployment

Install Node.js 22 and the agent CLIs you intend Jarvis to use, then:

```bash
git clone https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard.git
cd Jarvis-Sub-Agent-Dashboard
npm ci
cd client && npm ci && cd ..
npm run build
npm start
```

Jarvis serves the built client and API at `http://localhost:4820`.

Run the process under the host operating system's normal startup mechanism if it needs to survive reboots. Keep the repository and process under the same user account that owns the Codex/Claude CLI sessions and local configuration.

## Private access with Tailscale

Keep the server on loopback and set a strong dashboard token in `.env`:

```dotenv
DASHBOARD_TOKEN=replace-with-a-long-random-secret
DASHBOARD_ALLOWED_HOSTS=your-hostname.your-tailnet.ts.net
```

After Jarvis is running on port 4820, publish it inside the tailnet with Tailscale Serve:

```powershell
tailscale serve --bg 4820
```

Open the HTTPS URL printed by Tailscale from a trusted enrolled device. Supply the dashboard token once through the supported client flow; the API and WebSocket require it thereafter.

See the [official Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve) before changing this command on a newer client.

If direct tailnet binding is deliberately chosen instead, set `DASHBOARD_HOST=0.0.0.0` and allow only the exact MagicDNS name/IP values required. Tailscale Serve is preferred because it retains the loopback server boundary and provides HTTPS, which is required for reliable iPhone PWA features.

Do not publish port 4820 directly to the internet. Jarvis can read local agent data, access configured vault paths, and start agent processes.

## Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

The default Compose file publishes Jarvis only on host loopback at `http://localhost:4820` and stores SQLite data in the `dashboard-data` volume.

The container route is useful for the dashboard and read-only Claude history, but host-native agent execution and personal vault access require deliberate mounts and credentials. Prefer the direct host deployment for the full Jarvis OS.

## Persistent data

Jarvis keeps two distinct kinds of state:

- Operational SQLite state under `DASHBOARD_DATA_DIR`, or at the explicit `DASHBOARD_DB_PATH`. Keep it outside synced storage.
- Long-term Markdown knowledge under `JARVIS_NOTES_DIR`.

Back up both. Do not treat the SQLite database as the only copy of the Markdown brain.

## Updating

Review changes before updating a working host, then:

```bash
git pull --ff-only
npm ci
cd client && npm ci && cd ..
npm run build
```

Restart the Jarvis process after the build completes.

## Health check

Verify the server locally before testing remote access:

```bash
curl http://localhost:4820/api/health
```

If a dashboard token is enabled, add an `Authorization: Bearer <token>` header.

See [.env.example](.env.example) for all supported settings and [.github/SECURITY.md](.github/SECURITY.md) for the trust boundary.
