# Contributing to Jarvis Agentic OS

Thanks for helping improve Jarvis. The project is actively used and changes should stay focused, reversible, and easy to verify.

## Set up the project

```bash
git clone https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard.git
cd Jarvis-Sub-Agent-Dashboard
npm run setup
npm run dev
```

The API runs at `http://localhost:4820` and the Vite client at `http://localhost:5173`.

## Make a change

1. Branch from the repository's default branch.
2. Keep the change to one clear purpose.
3. Preserve unrelated work and existing local-first behaviour.
4. Add or update tests for changed behaviour.
5. Update documentation when configuration or user-facing behaviour changes.

Useful checks:

```bash
npm run test:server
npm run test:client
npm run build
```

For UI changes, include a before-and-after screenshot. For security-sensitive changes, describe the trust boundary and failure behaviour.

## Open a pull request

Explain the problem, the chosen solution, and exactly how a reviewer can verify it. Automated releases, deployment infrastructure, and speculative abstractions should not be added without a concrete use case.

By contributing, you agree that your contribution is licensed under the project's MIT License.

## Reporting problems

Open an issue for bugs and feature requests. Use a private [GitHub Security Advisory](https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard/security/advisories/new) for vulnerabilities.
