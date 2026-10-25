# Turing Terminal v1.0.0-rc3

Draft release notes only. No RC3 tag or GitHub Release has been published. Manual installer qualification artifacts are tracked in [V1_READINESS.md](V1_READINESS.md). Current qualification status is in [V1_READINESS.md](V1_READINESS.md).

## Artifacts

- Windows x64 installer: `Turing-Terminal-Setup-x64-1.0.0-rc3.exe`
- Linux x64 Debian package: `turing-terminal_1.0.0-rc3_amd64.deb`
- Portable Linux x64 package: `Turing-Terminal-x86_64-1.0.0-rc3.AppImage`
- `SHA256SUMS.txt` and `RELEASE_NOTES.md` accompany the built packages.

## What changed since rc2

- **Goal Engine and verified completion.** Goals can be defined, approved, persisted, recovered and authored. Child, proposal, review and verification work runs through ordinary persisted runs on the exact stored route. New completion requires a read-only versioned content verifier bound into immutable proof; ancestry-only proofs remain historical. The verifier compares Goal-changed paths at the first destination-history commit containing the accepted source, refuses LFS-filtered paths, caps work at 10,000 changed paths, and performs no Git writes. A content mismatch never counts as successful delivery through Policy B. Desktop-only routes return 403 `desktop_required` to paired remote callers. Attestations can be disputed, withdrawn or superseded through the append-only ledger. Goal delivery remains a manual handoff, and the checked-out-worktree writer remains quarantined. See [Goal Engine](goals/GOAL_ENGINE.md).
- **UI overhaul.** Merged after RC2: dark theme only, new shell, workspaces, mobile PWA layout, and skull branding. It was an owner-approved exception to the feature freeze. There is no theme switch.
- **Model Opportunity Layer.** The settings Board displays bounded catalog and price observations. Raw observations are retained for 90 days and deleted only by the explicit retention job. Completed admission proof remains valid for its exact definition until superseded; new admission or revalidation requires fresh observations. Only admitted OpenRouter Goal routes use the conservative MOP reservation estimator; the legacy estimator and Decision Layer behavior are unchanged.
- **Desktop installer artifact retention.** The Desktop installers workflow keeps the combined bundle artifact for seven days and deletes the per-platform Linux and Windows artifacts only after the combined bundle uploads successfully. A failed or cancelled run keeps its intermediate artifacts for one day.

## Unchanged

Carried over from rc2: the bundled Desktop Master remains the source of truth and continues serving the mobile PWA through Tailscale Serve. The Windows installer is unsigned, so Windows may show Unknown Publisher or SmartScreen warnings. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are optional external tools that Turing detects but does not install.

## Pending

Physical acceptance on Windows and Linux PCs, iPhone pairing and remote-run checks over Tailscale, second-machine isolation, notification checks, and Claude subscription validation after the provider allowance reset. A current-master OpenCode Go Beam Free subscription-lane Planner → Implementer → Reviewer workflow passed on 2026-10-25 with three successful broker operations. Codex current-code, Claude post-reset and ClinePass live validation remain unvalidated. No live OpenRouter or Jev request is recorded; those optional paths remain covered by mocked deterministic tests. Physical-device, Windows, restart and release qualification remain open. Release state and open gates are tracked in [V1_READINESS.md](V1_READINESS.md).

## Release state

Release state and the open gates are tracked in [V1_READINESS.md](V1_READINESS.md), and the release procedure is in [RELEASING.md](RELEASING.md). The RC2 notes remain in [RELEASE_NOTES_1.0.0-rc2.md](RELEASE_NOTES_1.0.0-rc2.md).
