# Codex app-server protocol snapshot

Generated from the installed `codex-cli 0.144.2` on 2026-07-14:

```sh
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

Jarvis pins the combined v2 schema plus the top-level client request, server
request, and notification schemas. Regenerate this directory when the installed
Codex CLI changes, review the protocol diff, then update the supervisor tests.
