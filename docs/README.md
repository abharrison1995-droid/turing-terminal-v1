# Documentation index

[V1_READINESS.md](V1_READINESS.md) is the release tracker. When another document disagrees with it about release state, it wins.

Many Goal and UI documents were written stage by stage. Their opening status lines ("pending independent review", "PR #3 stays open") describe the moment they were written, not today. Use them for contracts and decisions, and check the code for current behaviour.

## Current reference

| Area               | Documents                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product and design | [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md)                                                                                                                                                 |
| Workflows and runs | [WORKFLOWS.md](WORKFLOWS.md), [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md)                                                                                                                                                               |
| Providers          | [PROVIDERS.md](PROVIDERS.md), [PROVIDER_CAPABILITY_MATRIX.md](PROVIDER_CAPABILITY_MATRIX.md), [MODEL_CONFIGURATION.md](MODEL_CONFIGURATION.md), [OPENROUTER.md](OPENROUTER.md)                                                             |
| Provider internals | [phase3.6-provider-model-context.md](phase3.6-provider-model-context.md), [DECISION_LAYER.md](DECISION_LAYER.md)                                                                                                                           |
| Billing and usage  | [BILLING_SAFETY.md](BILLING_SAFETY.md), [USAGE_ACCOUNTING.md](USAGE_ACCOUNTING.md)                                                                                                                                                         |
| Security           | [SECURITY.md](SECURITY.md), [GOAL_TRUSTED_CALLER_BOUNDARY.md](GOAL_TRUSTED_CALLER_BOUNDARY.md)                                                                                                                                             |
| Install and run    | [DESKTOP_MASTER.md](DESKTOP_MASTER.md), [INSTALL_LINUX.md](INSTALL_LINUX.md), [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md), [MOBILE.md](MOBILE.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md)                                                   |
| Build and release  | [DEVELOPMENT.md](DEVELOPMENT.md), [PACKAGING.md](PACKAGING.md), [RELEASING.md](RELEASING.md), [RELEASE_NOTES_1.0.0-rc2.md](RELEASE_NOTES_1.0.0-rc2.md)                                                                                     |
| Live acceptance    | [LIVE_PROVIDER_VALIDATION.md](LIVE_PROVIDER_VALIDATION.md), [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md), [LIVE_TAILSCALE_ACCEPTANCE.md](LIVE_TAILSCALE_ACCEPTANCE.md), [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md) |
| UI evidence        | [ui/EVIDENCE.md](ui/EVIDENCE.md), [ui/MASCOT_PROVENANCE.json](ui/MASCOT_PROVENANCE.json), [ui/packet-reference/README.md](ui/packet-reference/README.md)                                                                                   |

### Goal Engine contracts

These define the authority boundaries the code enforces today.

- [GOAL_MANUAL_HANDOFF_CONTRACT.md](GOAL_MANUAL_HANDOFF_CONTRACT.md): how a reviewed Goal result is handed to the user for Git integration.
- [GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md](GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md): the user's attestation that integration happened.
- [GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md](GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md): version-2 completion policy and proofs.
- [GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md](GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md): correcting or withdrawing an attestation.
- [GOAL_FINAL_APPLY_AUTHORITY.md](GOAL_FINAL_APPLY_AUTHORITY.md): the final-apply approval contract. Its writer is quarantined; read it for the historical records it defines.

## Proposals awaiting an owner decision

- [GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md](GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md): refuse merges that discard accepted Goal work.
- [GOAL_X1_AUTH_WORDING_PROPOSAL.md](GOAL_X1_AUTH_WORDING_PROPOSAL.md): wording for the authentication boundary.

## History

Kept for the evidence trail. Do not read these as current state. Those not yet in `docs/history/` will move there.

- Baselines and old releases: [PHASE2_BASELINE.md](PHASE2_BASELINE.md), [PHASE3_BASELINE.md](PHASE3_BASELINE.md), [RELEASE_NOTES_1.0.0-rc1.md](RELEASE_NOTES_1.0.0-rc1.md).
- Goal Engine design and stage records: [GRAND_PROJECT_GOAL_ENGINE_DESIGN.md](GRAND_PROJECT_GOAL_ENGINE_DESIGN.md), [GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md](GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md), [GOAL_E2E_ACCEPTANCE_MATRIX.md](GOAL_E2E_ACCEPTANCE_MATRIX.md), [GOAL_FINAL_APPLY_REF_ONLY_DECISION.md](GOAL_FINAL_APPLY_REF_ONLY_DECISION.md), [GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md](GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md), [GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md](GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md), [GOAL_CROSS_ATTESTATION_RECOVERY_DESIGN.md](GOAL_CROSS_ATTESTATION_RECOVERY_DESIGN.md), [GOAL_D32_CONSUMER_AUDIT.md](GOAL_D32_CONSUMER_AUDIT.md), [GOAL_ENGINE_CLOSURE_2026-10-17.md](GOAL_ENGINE_CLOSURE_2026-10-17.md).
- UI overhaul packets (completed): [ui/UI0_SPEC.md](ui/UI0_SPEC.md), [ui/UI_BASELINE_ACCEPTANCE.md](ui/UI_BASELINE_ACCEPTANCE.md), [ui/UI1B_SCOPE.md](ui/UI1B_SCOPE.md), [ui/UI1C_SCOPE.md](ui/UI1C_SCOPE.md), [ui/UI2_SCOPE.md](ui/UI2_SCOPE.md), [ui/UI3_SCOPE.md](ui/UI3_SCOPE.md), [ui/UI4_SCOPE.md](ui/UI4_SCOPE.md), [ui/UI5_SCOPE.md](ui/UI5_SCOPE.md), [ui/UI6_SCOPE.md](ui/UI6_SCOPE.md), [ui/UI9_SCOPE.md](ui/UI9_SCOPE.md).
- [history/V1_READINESS_LOG.md](history/V1_READINESS_LOG.md): the readiness tracker's stage-by-stage record, frozen on 2026-10-20.
