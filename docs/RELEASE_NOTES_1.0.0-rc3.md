# Turing Terminal v1.0.0-rc3 (draft)

**Draft notes for preparation only.** No RC3 has been cut. There is no `v1.0.0-rc3` tag, no RC3 build, no published release, and no uploaded installer artifact for this version. These notes record what the RC3 code contains so they can be reviewed before any tag is created.

## Planned artifact names

- Windows x64 installer: `Turing-Terminal-Setup-x64-1.0.0-rc3.exe`
- Linux x64 Debian package: `turing-terminal_1.0.0-rc3_amd64.deb`
- Portable Linux x64 package: `Turing-Terminal-x86_64-1.0.0-rc3.AppImage`
- `SHA256SUMS.txt` and `RELEASE_NOTES.md` accompany the built packages.

These names are reserved for a future RC3 build. The files do not exist yet and no checksums have been produced.

## What changed since rc2

- **Goal Engine (Grand Projects).** The Goal Engine was merged after RC2, along with its follow-up work. Goals can be defined, approved, persisted, recovered, and authored, and proposal, child, review, and verification runs go through ordinary persisted runs on the exact route. Acceptance was deterministic only: it is not live-provider, physical-device, or release qualification, and it does not start the Model Opportunity Layer. The accepted Goal composition sits on development HEAD `e6120c1`, which `master` CI does not cover. Goal delivery is manual handoff only, so Turing never writes the user's base branch, and the checked-out-worktree writer stays quarantined. Goal completion is version 2: the user attests external integration, Turing observes ancestry, and a separate recorded user decision completes the Goal with a proof. Desktop-only routes return 403 `desktop_required` to paired remote callers, and attestations can be disputed, withdrawn, or superseded through an append-only ledger. See [Goal Engine](goals/GOAL_ENGINE.md).
- **UI overhaul.** Merged after RC2: dark theme only, new shell, workspaces, mobile PWA layout, and skull branding. It was an owner-approved exception to the feature freeze. There is no theme switch.
- **Desktop installer artifact retention.** The Desktop installers workflow keeps the combined bundle artifact for seven days and deletes the per-platform Linux and Windows artifacts only after the combined bundle uploads successfully. A failed or cancelled run keeps its intermediate artifacts for one day.

## Unchanged

Carried over from rc2: the bundled Desktop Master remains the source of truth and continues serving the mobile PWA through Tailscale Serve. The Windows installer is unsigned, so Windows may show Unknown Publisher or SmartScreen warnings. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are optional external tools that Turing detects but does not install. Provider independence, the billing modes, the optional OpenRouter and Decision Layer paths, metered budgets, model configuration, usage analytics, and database migration 014 are as shipped in RC2.

## Pending

Physical acceptance on Windows and Linux PCs, iPhone pairing and remote-run checks over Tailscale, second-machine isolation, notification checks, and Claude subscription validation after the provider allowance reset. No live provider run has been made since RC2, so no live OpenRouter or Jev request exists for RC3 either; those paths remain covered by deterministic tests with mocked responses. Live-provider, physical-device, Windows, and release qualification for the Goal Engine is not started.

## Release state

No RC3 has been cut. Nothing in this document is a tag, a build, a publication, a live-provider validation, or a physical-device qualification. Release state and the open gates are tracked in [V1_READINESS.md](V1_READINESS.md), and the release procedure is in [RELEASING.md](RELEASING.md). The RC2 notes remain in [RELEASE_NOTES_1.0.0-rc2.md](RELEASE_NOTES_1.0.0-rc2.md).
