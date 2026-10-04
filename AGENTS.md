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
- Do not claim live-provider or physical-device capability from tests alone.
- Never put secrets in the repository, workflows, profiles, or logs.

## Release state and scope

See [docs/V1_READINESS.md](docs/V1_READINESS.md). V1 still intends to add the **Grand Project Planner / Goal Engine** and the **Model Opportunity Layer**, then enters strict feature freeze and hardening. The Goal Engine must sit above `RunEngine`, not rewrite it.

## Validation gate

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Do not weaken tests to get green output.

## Documentation map

- [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md)
- [docs/V1_READINESS.md](docs/V1_READINESS.md)
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/BILLING_SAFETY.md](docs/BILLING_SAFETY.md), [docs/MODEL_CONFIGURATION.md](docs/MODEL_CONFIGURATION.md), [docs/CONTEXT_MANAGEMENT.md](docs/CONTEXT_MANAGEMENT.md)
- [docs/PROVIDER_CAPABILITY_MATRIX.md](docs/PROVIDER_CAPABILITY_MATRIX.md), [docs/USAGE_ACCOUNTING.md](docs/USAGE_ACCOUNTING.md)
- Live acceptance: [LIVE_PROVIDER_VALIDATION](docs/LIVE_PROVIDER_VALIDATION.md), [CLAUDE_VALIDATION](docs/CLAUDE_VALIDATION.md), [LIVE_TAILSCALE_ACCEPTANCE](docs/LIVE_TAILSCALE_ACCEPTANCE.md), [LIVE_MULTIMACHINE_ACCEPTANCE](docs/LIVE_MULTIMACHINE_ACCEPTANCE.md)

## Historical documents

`docs/PHASE2_BASELINE.md`, `docs/PHASE3_BASELINE.md`, and `docs/RELEASE_NOTES_1.0.0-rc1.md` are historical snapshots. Do not read them as current product state.

## Working rules

Inspect existing architecture first, design additive types/storage, add migration and acceptance tests, run the full gate, and commit coherent units. Do not push tags or publish releases without explicit user approval. If a request conflicts materially with the architecture, stop and propose the smallest compatible design.
