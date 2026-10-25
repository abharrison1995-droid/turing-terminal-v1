# Documentation index

[V1_READINESS.md](V1_READINESS.md) is the release tracker. When another document disagrees with it about release state, it wins. It is canonical for release state, including the state of work a proposal describes. Release state checked 2026-10-25.

Layout:

- `docs/`: current reference.
- `docs/goals/`: the Goal Engine overview and the contracts it enforces.
- `docs/proposals/`: designs and wording proposals. They remain design records, not complete behaviour: a proposal can carry an approved decision while its implementation is still partial or absent. Each records its own decision status.
- `docs/history/`: frozen records. Do not read them as current state.
- `docs/ui/`: UI evidence and design references.

`npm run docs:links` checks every relative link outside `docs/history/`; CI runs it.

## Current reference

| Area               | Documents                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product and design | [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md)                                                                                                                                                 |
| Workflows and runs | [WORKFLOWS.md](WORKFLOWS.md), [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md)                                                                                                                                                               |
| Providers          | [PROVIDERS.md](PROVIDERS.md), [PROVIDER_CAPABILITY_MATRIX.md](PROVIDER_CAPABILITY_MATRIX.md), [MODEL_CONFIGURATION.md](MODEL_CONFIGURATION.md), [OPENROUTER.md](OPENROUTER.md), [DECISION_LAYER.md](DECISION_LAYER.md)                     |
| Billing and usage  | [BILLING_SAFETY.md](BILLING_SAFETY.md), [USAGE_ACCOUNTING.md](USAGE_ACCOUNTING.md)                                                                                                                                                         |
| Security           | [SECURITY.md](SECURITY.md), [goals/GOAL_TRUSTED_CALLER_BOUNDARY.md](goals/GOAL_TRUSTED_CALLER_BOUNDARY.md)                                                                                                                                 |
| Install and run    | [DESKTOP_MASTER.md](DESKTOP_MASTER.md), [INSTALL_LINUX.md](INSTALL_LINUX.md), [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md), [MOBILE.md](MOBILE.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md)                                                   |
| Build and release  | [DEVELOPMENT.md](DEVELOPMENT.md), [PACKAGING.md](PACKAGING.md), [RELEASING.md](RELEASING.md), [RELEASE_NOTES_1.0.0-rc3.md](RELEASE_NOTES_1.0.0-rc3.md)                                                                                     |
| Live acceptance    | [LIVE_PROVIDER_VALIDATION.md](LIVE_PROVIDER_VALIDATION.md), [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md), [LIVE_TAILSCALE_ACCEPTANCE.md](LIVE_TAILSCALE_ACCEPTANCE.md), [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md) |
| UI evidence        | [ui/EVIDENCE.md](ui/EVIDENCE.md), [ui/MASCOT_PROVENANCE.json](ui/MASCOT_PROVENANCE.json), [ui/packet-reference/README.md](ui/packet-reference/README.md)                                                                                   |

The current release-candidate notes are [RELEASE_NOTES_1.0.0-rc3.md](RELEASE_NOTES_1.0.0-rc3.md), prepared for RC3; a manual installer qualification build is recorded in the tracker. No RC3 tag or GitHub Release exists. Release state remains in [V1_READINESS.md](V1_READINESS.md). [RELEASE_NOTES_1.0.0-rc2.md](RELEASE_NOTES_1.0.0-rc2.md) is the historical prior release record. collect-release.mjs and merge-release.mjs read `RELEASE_NOTES_<version>.md`.

## Goal Engine

Start with [goals/GOAL_ENGINE.md](goals/GOAL_ENGINE.md): what the Goal Engine is, what runs in production, and where the code is. The contracts below define the authority boundaries the code enforces today.

- [GOAL_MANUAL_HANDOFF_CONTRACT.md](goals/GOAL_MANUAL_HANDOFF_CONTRACT.md): how a reviewed Goal result is handed to the user for Git integration.
- [GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md](goals/GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md): the user's attestation that integration happened.
- [GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md](goals/GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md): version-2 completion policy and proofs.
- [GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md](goals/GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md): correcting or withdrawing an attestation.
- [GOAL_FINAL_APPLY_AUTHORITY.md](goals/GOAL_FINAL_APPLY_AUTHORITY.md): the final-apply approval contract. Its writer is quarantined; read it for the historical records it defines.
- [GOAL_TRUSTED_CALLER_BOUNDARY.md](goals/GOAL_TRUSTED_CALLER_BOUNDARY.md): which local and remote callers are trusted.

These were written stage by stage. Their opening status lines ("pending independent review", "PR #3 stays open") describe the moment they were written, not today.

## Proposals and recorded decisions

A proposal is a design record; the approved decision and the implementation state are separate, and both can change.

- [GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md](proposals/GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md): the owner decision on refusing merges that discard accepted Goal work was approved on 2026-10-21 (a new content verifier for new completions; ancestry-only records for older completions stay historical and immutable). The collector, LFS refusal, persistence, completion wiring and API/UI standing are merged into master through PR #15. Full release qualification remains open; see [V1_READINESS.md](V1_READINESS.md).
- [MODEL_OPPORTUNITY_LAYER_DESIGN.md](proposals/MODEL_OPPORTUNITY_LAYER_DESIGN.md): the retention decision was approved on 2026-10-21 (90 days; references for active admission held through expiry; deletes by an explicit job). The bounded observation store, admission proof, explicit retention job, conservative MOP-only OpenRouter reservation estimate and Board are merged into master through PR #15. Full release qualification remains open; see [V1_READINESS.md](V1_READINESS.md).
- [GOAL_X1_AUTH_WORDING_PROPOSAL.md](proposals/GOAL_X1_AUTH_WORDING_PROPOSAL.md): wording for the authentication boundary. The underlying O1 decision is recorded: the same-user local-process residual was conditionally accepted for V1 on 2026-10-13, with live Tailscale identity-header/Host verification as its condition; O2 may be post-V1. The exact proposed prose was not separately approved.

## History

Kept for the evidence trail. Links inside these files are not checked and may point at removed evidence.

- [V1_READINESS_LOG.md](history/V1_READINESS_LOG.md): the stage-by-stage readiness log, frozen on 2026-10-20.
- Baselines and old releases: [PHASE2_BASELINE.md](history/PHASE2_BASELINE.md), [PHASE3_BASELINE.md](history/PHASE3_BASELINE.md), [RELEASE_NOTES_1.0.0-rc1.md](history/RELEASE_NOTES_1.0.0-rc1.md), [phase3.6-provider-model-context.md](history/phase3.6-provider-model-context.md).
- Goal Engine design and stage records in [history/goals/](history/goals/): the original design, the implementation progress record, the acceptance matrix, the ref-only and attestation designs, the D32 consumer audit and the 2026-10-17 closure report.
- UI overhaul packets in [history/ui/](history/ui/): the UI.0 spec, the baseline acceptance and the UI.1b to UI.9 scopes.
