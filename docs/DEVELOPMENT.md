# Development

## Prerequisites

- Node.js 22 or newer
- npm
- Git (needed for Git detection and worktree workflows)
- One of the supported provider CLIs (OpenAI Codex CLI, OpenCode, Claude Code, or Cline) only if testing provider execution

Install dependencies and run both the local service and Vite development server:

```sh
npm install
npm run dev
```

The UI is served at `http://127.0.0.1:5173`; the API is at `http://127.0.0.1:4317`. Data is written to `~/.turing-terminal` unless `TT_DATA_DIR` is set. `TT_HOST` accepts loopback values only. `TT_PORT` changes the local API port.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

`npm start` serves the production build from `dist` and loads the compiled Node service from `dist-server`. Run it from the repository root so the compiled service can find the application migrations and static assets.

## Data and migrations

Database changes belong in a numbered SQL file under `migrations/`. The service applies each file once and stores its filename in `schema_migrations`. Keep migrations additive and safe for an existing local database. Tests should use a temporary `TT_DATA_DIR` or in-memory SQLite connection rather than the developer's normal data directory.

Provider adapters are in `src/server/providers.ts`; shared capability descriptions live in `src/shared/types.ts`. Keep capability claims synchronized with the [provider matrix](PROVIDER_CAPABILITY_MATRIX.md), and leave unsupported telemetry as null/unavailable. Do not add API-key fallback behavior to a subscription adapter. The subscription-backed Codex adapter requires ChatGPT CLI authentication and a dynamically discovered model.

Provider/model identity, reusable connection profiles, presets, catalog snapshots, context budgets, and subscription-only billing rules are described in [Phase 3.6 provider, model, and context configuration](phase3.6-provider-model-context.md). When changing these types or adapters, update that reference together with [Workflows](WORKFLOWS.md), [Provider setup](PROVIDERS.md), and the capability matrix. The deterministic OpenCode Go and ClinePass acceptance coverage is in `src/server/app.test.ts`; keep route, variant, context-limit, and usage-attribution assertions aligned with the saved schema.
