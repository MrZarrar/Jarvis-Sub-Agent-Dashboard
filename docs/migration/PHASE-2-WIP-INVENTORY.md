# Phase 2 Mac WIP inventory

- Recovery source: `wip/mac-2026-07-27` at `2525e9e`
- Reconciled branch: `dev/personal-pc`
- Decision date: 2026-08-06

The recovery branch remains intact. A remaining Git diff against it is expected and is not unfinished merge work.

## Keep

| Feature slice | Reconciled result | Commit |
| --- | --- | --- |
| Codex provider foundation | Provider, stream parsing, managed app-server, watcher, lifecycle tests | `312bdc3` |
| Unified missions | Mission policy, persistence, APIs, schedules, provider metadata, Missions UI | `2e06fc5` |
| Project and workspace files | Guarded project-file module, API, MCP tools, tests, UI entry points | `58373aa` |
| Vault and brain | Notes, entity engine, graph/recall surfaces, guarded writes, tests | `754828f` |
| Personal and business surfaces | DEV/BIZ mode, separate business Today lane, briefings, business workspace, dormant integrations, subscription-only Mini Jarvis routing | `6b1fece` |
| Agent roster | Codex mission/personal/business roles and Claude Scout/Forge/Sentinel/Ops development crew | `266b1d6` |
| Mission subscription policy | Generic mission defaults moved from dormant Groq/Gemini routes to signed-in Codex | `61635bc` |
| Current Jarvis documentation | Windows setup, concise architecture, provider policy, data boundaries, Ops Room, deployment guidance | `ecacf47` |

Finance and scheduling surfaces already present on the cleaned branch were retained in their newer form rather than overwritten by the older WIP copies.

## Defer

These remain later master-plan work, not Phase 2 harvest omissions:

- Brain PIN Lock.
- Company Node Eviction and Full Offboarding.
- Personal-PC development, worker, and future company-core environment profiles.
- Moving or piloting `JarvisNotes` through iCloud and creating the real `JarvisBusiness` workspace.
- Always-on company-core deployment, authenticated Tailscale HTTPS, startup service, backup automation, and phone acceptance tests.
- Provider-neutral remote worker registration and dispatch.
- Optional Codex Cloud and Claude web overflow workers.
- Business credentials, live marketplace actions, financial actions, publishing, and messaging.
- Session-only BIZ filtering and further cosmetic business-mode sprite work.

## Reject

The following recovered material is intentionally not part of the personal Jarvis branch:

- A wholesale merge of `2525e9e`.
- Kubernetes, Helm, Kustomize, Terraform, multi-cloud, blue-green, canary, Prometheus, Grafana, Coralogix, and enterprise deployment examples under `deployments/`.
- Translated full READMEs, the generated wiki/marketing site, root website assets, badges, image dumps, fonts, sitemaps, and duplicated documentation.
- `.idea` and other personal IDE metadata.
- Generated `graphify-out` artifacts.
- CLA/contribution bureaucracy and stale upstream product claims.
- Default Ollama/local-model routing.
- Default Groq, Gemini, OpenAI API, or Anthropic API billing routes.
- Older WIP copies of Finance, Schedules, and other files when the cleaned branch already contains the newer accepted implementation.
- Dormant provider changes that would silently cross billing boundaries or claim unavailable capabilities.

## Gate interpretation

Phase 2 is complete only when this inventory is committed, the working tree is clean, all server/client/MCP checks and the client production build pass, and the branch is pushed. Later phases may deliberately revisit deferred items; rejected items require a new concrete requirement and review.
