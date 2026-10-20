# AGENTS.md

Canonical context for any coding agent working in this repository. Release status lives in [docs/V1_READINESS.md](docs/V1_READINESS.md); do not copy transient status here.

## Product

Turing Terminal is a local-first AI development orchestration control plane. The **Desktop Master** owns repository access, provider processes, persistence, secrets, and workflow execution. The **phone/PWA is a remote control only** and never runs agents or holds credentials.

## Architectural invariants

- The deterministic workflow engine is authoritative. Models are never the state machine.
- No unrestricted model-generated shell. Repository access goes through Turing's execution broker and permission modes.
- No silent provider substitution and no silent model substitution. Exact routes are persisted and snapshotted per run.
- Subscription-backed paths must never silently fall into API/PAYG/metered billing. One billing evaluator (`evaluateBillingLane`) is used everywhere.
- OpenRouter is optional. Decision Layer/Jev is optional and off by default.
- Usage claims keep provenance (provider-reported, locally observed, estimated, unavailable).
- One usage ledger, one approval system, one model catalog. Extend them; do not build parallel ones.
- The Goal Engine sits above `RunEngine` and executes ordinary bounded runs. It must not rewrite `RunEngine`.
- Turing never writes the user's base branch. Goal results reach it only through the user-controlled manual handoff. The checked-out-worktree final-apply writer (`applyApprovedGoalToBase` in `src/server/goals/finalApply.ts`) stays quarantined and unreachable; do not delete or wire it.
- Goal completion and correction decisions are desktop-only. Paired remote callers are refused (`desktop_required`).
- Do not claim live-provider or physical-device capability from tests alone.
- Never put secrets in the repository, workflows, profiles, or logs. The repository is public.

## Shape of the code

- `src/server/`: the Desktop Master (Fastify, SQLite via `better-sqlite3`). `runEngine.ts` drives runs, `app.ts` holds most HTTP routes, `goals/` is the Goal Engine (supervisor, handoff, attestation, completion and correction services, `goalRoutes.ts`).
- `src/client/`: the React UI shared by the desktop shell and the phone PWA. Tokens are in `src/client/styles/tokens.css`.
- `src/shared/`: types and pure logic used by both sides.
- `migrations/`: numbered SQL, applied once by filename (`src/server/db.ts`). Never rename or edit an applied migration; add a new one.
- `src-tauri/`, `packaging/`, `scripts/`: desktop shell and installers.
- `e2e/`: Playwright screenshot harness, not part of the gate.

## Release state and scope

See [docs/V1_READINESS.md](docs/V1_READINESS.md). In short:

- The Goal Engine is merged, but production constructs `DisabledGoalExecutor` (`src/server/index.ts`). Goals persist, recover and accept user authoring runs, but cannot start child, proposal or review runs.
- The Model Opportunity Layer is V1 scope and not started.
- Physical-device and live-provider acceptance are incomplete.

## Validation gate

The same commands run in `.github/workflows/ci.yml`:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run docs:links
```

Do not weaken tests to get green output.

## Documentation

[docs/README.md](docs/README.md) is the index. It marks each document as current reference, a proposal awaiting an owner decision, or history: current reference is in `docs/`, the Goal Engine overview and contracts in `docs/goals/`, proposals in `docs/proposals/` and frozen records in `docs/history/`. Do not read a history document, or the stage-by-stage status lines inside Goal design documents, as current product state.

## Working rules

Inspect existing architecture first, design additive types/storage, add migration and acceptance tests, run the full gate, and commit coherent units. Do not push tags or publish releases without explicit user approval. If a request conflicts materially with the architecture, stop and propose the smallest compatible design.
