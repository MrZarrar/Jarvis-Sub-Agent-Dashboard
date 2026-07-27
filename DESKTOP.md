# Jarvis Desktop App

The `desktop/` workspace packages the Jarvis server and client in an Electron shell for macOS and Windows.

The desktop app is retained as a source-build option. Jarvis does not currently publish maintained installers or automatic GitHub releases.

## What it provides

- Starts the embedded Jarvis server with the desktop application.
- Keeps the server alive when the main window is hidden.
- Adds a tray/menu-bar entry, native menu, and native notifications.
- Stores writable data outside the installed application bundle.
- Can open the same dashboard in a normal browser.

The desktop shell is optional. For an always-on host, running `npm start` under the operating system's startup mechanism is simpler and easier to inspect.

## Build from source

Install and build the main application first:

```bash
npm run setup
npm run build
npm run desktop:install
```

### macOS

Build on macOS:

```bash
npm run desktop:dmg:arm64
npm run desktop:dmg:x64
```

Use the architecture that matches the Mac. The generated files are written under `desktop/release/`.

### Windows

Build on Windows:

```bash
npm run desktop:win
npm run desktop:win:portable
```

These create an installer or portable executable under `desktop/release/`.

Electron packaging is host-specific: build macOS packages on macOS and Windows packages on Windows.

## Development

```bash
npm run desktop:dev
npm run desktop:test
```

The desktop app prefers port 4820. If a healthy Jarvis server already owns that port, the shell can use the existing server instead of starting a second copy.

## Data and logs

The packaged application uses the Electron per-user application-data and log directories. This keeps SQLite and runtime logs outside the signed/read-only application bundle and allows data to survive application replacement.

Use the tray menu's **Show Logs** action when diagnosing a blank window or failed server start.

## Current limitations

- No maintained pre-built downloads.
- No automatic updater.
- Signing and notarisation require the maintainer's platform credentials.
- The desktop product name and identifiers still contain legacy Claude Code Monitor values in parts of the Electron workspace and should be migrated before a public Jarvis desktop release.

For normal host and Tailscale operation, use [DEPLOYMENT.md](DEPLOYMENT.md).
