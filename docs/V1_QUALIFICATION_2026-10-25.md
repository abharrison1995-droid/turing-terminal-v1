# V1 release qualification evidence — 2026-10-25

Release status remains in [V1_READINESS.md](V1_READINESS.md). This evidence record does not authorize tagging, publication, a 1.0.0 version change or merging the qualification PR.

## Baseline and commands

- `git status --short --branch`: original branch `codex/v1-release-preparation-2026-10-21` at `e04755b205876d19de8b68d24392b36ed9ff22c9`, no tracked edits, eight untracked `.codex-*` directories. No scratch files staged or removed; caches preserved.
- `git fetch origin` and `git ls-remote origin refs/heads/master`: master `6e5119f7e59220f8a825cefecf9b28b578e8bbb0`. GitHub connector PR metadata independently confirmed PR #15 merged at 17:02:30 UTC with that merge SHA.
- `gh api repos/abharrison1995-droid/turing-terminal-v1/actions/runs/40212386872`: final PR-head CI success on `e04755b205876d19de8b68d24392b36ed9ff22c9`.
- `gh run list --limit 8 --json databaseId,headSha,workflowName,event,conclusion`: master push CI [40214541599](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40214541599) success on `6e5119f`; these are GitHub-reported outcomes, not inferred from local tests.
- GitHub job metadata for master CI job `121232725342` independently reports success for every AGENTS.md gate step. `gh run view --log` returned no log text, so no GitHub test count is inferred from that command.
- `git switch -c codex/v1-qualification-2026-10-25 origin/master`: qualification work isolated on a dedicated branch. Only documentation changes are required so far.
- `bash -n scripts/smoke-linux-packages.sh`: passed. `npm exec vitest run scripts/packagingMetadata.test.mjs`: two tests passed. An initial `node --test` invocation was the wrong runner for this Vitest file and failed before executing its tests; corrected without any source change.
- Full local gate: `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`, `npm run docs:links`. All eight commands passed on 2026-10-25 on merge `6e5119f` plus documentation edits. `npm ci` installed 629 packages; `npm test` passed 232 files / 4,118 tests in 1,547.89 seconds; build had one non-failing chunk warning; production audit found zero vulnerabilities; links covered 93 Markdown files. Formatting/links are rerun after the final evidence edits. Local logs: `/tmp/turing-v1-qualification-20261025/` (temporary).

## Live provider evidence

The [OpenCode Go record](LIVE_PROVIDER_VALIDATION.md#opencode-go-current-master-validation--2026-10-25) documents the actual bounded current-master workflow, exact route, billing evaluator, operation IDs and usage uncertainty. A [sanitized run capture](qualification/2026-10-25-opencode-go.json) preserves stage snapshots, operation IDs and ledger provenance. The raw capture is local evidence; no credentials or live user database are included in this document.

- Raw capture SHA-256: `4216ce1918860e86da64a74d9f53ee9a34d8073956de1e45c5c4f373ad103b7f`.
- Fixture file SHA-256: `4f20d1496862c120d9acc5ac4485ef050bf8d47ae879226d550d9a2b8961ee67` (46 bytes).
- Run: `3f428feb-c029-485f-912b-8832387da4ce`; three passed stages, three successful broker operations, three successful usage rows; no provider/model fallback.

## Installer qualification

`gh workflow run desktop-installers.yml --ref master` started [run 40229492053](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40229492053) on `6e5119f7e59220f8a825cefecf9b28b578e8bbb0`. This invokes native hosted Linux/Windows builds and smoke checks; it does not create a tag or GitHub Release. All three jobs completed successfully: Linux `121277954767`, Windows `121277954952` and combined bundle (see [GitHub run metadata](qualification/2026-10-25-installer-run.json)). RC2 artifacts are not evidence for this commit.

Windows intermediate artifact `12612589329` (`turing-terminal-windows-rc3`) was downloaded from this exact run. `7z l -slt` and `7z x` successfully inspected/extracted the actual NSIS installer. Its [persistent inventory](qualification/2026-10-25-windows-package.json) confirms RC3 app/server, all 32 migrations including 033/034, frontend index, server entry, bundled `node.exe` and only `win32-x64.node`. No developer packages or symlinks were found. All 32 packaged migrations match source after CRLF-to-LF normalization (Windows checkout line endings differ from Linux). The existing scanner, repointed without changing its rules to the extracted resource tree, passed recognized-pattern checks.

`Turing-Terminal-Setup-x64-1.0.0-rc3.exe`: 34,043,378 bytes; independently computed SHA-256 `7581d6317a4d1605d276c3092848c637e95df94265920f3bb6a366edf23803e8`. A local copy is retained at `artifacts/qualification-2026-10-25/` (Git-ignored). Hosted Windows install/startup/PWA/uninstall smoke passed; physical Windows acceptance remains pending. Intermediate artifacts expire after one day or are deleted after successful combined upload; the final combined artifact has seven-day retention.

Static inspection confirms staging builds frontend/server, includes migrations and production dependencies, prunes SQLite prebuilds to the target platform, bundles Node, and invokes the package security scan. The workflow combines exactly three versioned installer formats and generates SHA-256 sums. The Windows installer remains unsigned. The actual artifacts described below were verified; this static review alone would not establish their contents.

### Combined RC3 artifact

Artifact `12613251995`, `Turing-Terminal-1.0.0-rc3`, was downloaded from the successful run. GitHub reports archive digest `sha256:efd7cd84fbb3b9d4a94d8f37310d3cefb4e819f227dcabba7d241953e235c109` and expiry **2026-11-01 20:43:57 UTC**. `sha256sum -c SHA256SUMS.txt` independently returned OK for all three installers; the Windows hash also matched the earlier intermediate download. [Installer checksums](qualification/2026-10-25-SHA256SUMS.txt) are committed; full local files and the original manifest/notes are retained under Git-ignored `artifacts/qualification-2026-10-25/`.

| Installer    |       Bytes | SHA-256                                                            |
| ------------ | ----------: | ------------------------------------------------------------------ |
| AppImage     | 136,980,984 | `2113e5b1d004b0f817cb1abe57ffc79e6f583ad40fbe19ec81036f7e4acb6bc0` |
| DEB          |  66,378,296 | `c6a0e8e45af063ba0433b2cf21f3fe9f8a0664332c22270b1febe76dfd9d94f2` |
| Windows NSIS |  34,043,378 | `7581d6317a4d1605d276c3092848c637e95df94265920f3bb6a366edf23803e8` |

`dpkg-deb --info/--extract` and AppImage `--appimage-extract` inspected the real Linux payloads without installing or launching the desktop shell. The DEB declares version RC3, architecture amd64, GTK 3 and WebKitGTK 4.1 dependencies. [Linux inventories](qualification/2026-10-25-linux-packages.json) confirm frontend/server RC3, bundled Node, target SQLite prebuild, all 32 migrations byte-for-byte matching source, no developer packages and no resource symlinks. Of 8,721 resource files per format, 8,719 matched by SHA-256. The bundled Node and SQLite native module differ where AppImage bundling adjusts ELF loader paths; their executable `.text` sections were independently extracted with `objcopy` and matched by SHA-256. The inventory records both dynamic-loader paths and code-section hashes. Both extracted resource trees passed the same recognized-pattern scanner; this does not constitute exhaustive binary/credential analysis.

The bundled release notes were frozen at build commit `6e5119f`, before this qualification follow-up; use the canonical readiness tracker for newer results. No artifact was rewritten, tagged or published as a GitHub Release. A later release commit must pass its own required gates.

## Actual DEB Master recovery

The Node executable and compiled production Master extracted from the checksummed DEB were launched twice on loopback port 45192 with a fresh disposable data directory and no provider stages. [Persistent recovery evidence](qualification/2026-10-25-deb-master-recovery.json) records run `94ed99f0-cb67-4806-97c1-3b1924ab05b2`: queued before first startup, recovered to approval, approved/completed, and still completed after the second launch. Exactly one recovery, approval request/decision, stage start/completion and run completion remained; no usage or broker operations occurred. Health identified RC3 and loopback-only service.

This is actual packaged-Master process evidence for ordinary queued-run recovery. The fixture seeds the queued-before-start window rather than forcing an OS crash. The installed desktop-shell lifecycle and Goal resume remain unqualified; the existing user Master and occupied port were not touched.

## Fresh desktop resources and bundled Master restart

A disposable `git archive HEAD` export of `6e5119f` ran `npm ci` and `npm run desktop:prepare` successfully, independently of the user's ignored staging. The package scan passed for recognized patterns. [Persistent staging/restart evidence](qualification/2026-10-25-bundled-master.json) records inventory and subprocess outcomes.

- Fresh app/server versions both `1.0.0-rc3`; all 32 SQL files present, including migrations 033 and 034 (filenames have gaps).
- Bundled Node `v22.23.1`; only `linux-x64.node` SQLite prebuild. No symlinks or Vitest/TypeScript/Vite/ESLint/Tauri CLI developer packages found in the 8,721 staged files.
- The actual staged Node executable launched the compiled production `dist-server/server/index.js` twice on loopback port 45192 with isolated data. Health returned RC3 and `localOnly: true`.
- Run `ae44ff28-da62-4a0e-8e03-4b46a24d1496` was persisted as `queued` before first launch, recovered to `waiting_for_approval`, approved and completed. A second launch preserved completion. Exactly one recovery, approval request/decision, stage start/completion and run completion event remained; usage and broker-operation counts were zero.
- This seeds the queued-before-start crash window and exercises real process startup/restart without a provider. It is narrower than HR-Q4 on an installed release, does not force an OS crash and does not cover Goal resume. Those mandatory gates remain open.

## Available physical environment

Read-only `uname -a` identifies one actual Linux x86_64 host (Ubuntu kernel `6.8.0-146-generic`). `tailscale status --json` reports running, self online and one peer; `tailscale serve status --json` reports HTTPS on 443, one web handler and no Funnel. Peer presence does not establish control of a second computer or access to its screen. A read-only socket probe found port 4320 occupied within the desktop shell's reuse range (4317–4348). Launching another shell could attach to that existing service even with isolated XDG directories, so native launch/install acceptance on this host requires a separate OS session/account or owner-controlled shutdown of the existing Master. The existing service was not contacted or stopped. No Windows desktop or controllable physical iPhone session is available to this qualification. No Tailscale settings or live Master were changed. This observation does not satisfy the live identity-header/Host gate.

## Remaining physical actions

Use the exact build commit and checksummed installer in every record. Record OS/device, time, artifact SHA-256, outcome and redacted logs/screenshots. Never include provider credentials, pairing codes or session cookies.

| Action                            | Smallest procedure                                                                                                                                                                                                                                                                                                                                         | Evidence needed                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows and Linux install         | Install the NSIS and DEB/AppImage on their actual target PCs; launch, open dashboard/PWA, confirm bundled runtime works without system Node, close/reopen, check retained data and uninstall behavior. Follow [Windows](INSTALL_WINDOWS.md) and [Linux](INSTALL_LINUX.md) procedures.                                                                      | Installer SHA/commit, OS version, startup health/version and UI capture, data-retention result, uninstall result. Hosted CI is separate evidence.                                                                                                     |
| iPhone PWA and Tailscale boundary | Run remaining [phone acceptance](LIVE_TAILSCALE_ACCEPTANCE.md) steps with QR and manual pairing, home-screen launch, a lock of at least 30 seconds, approval/intervention, relaunch, notifications if configured and revocation. Capture real Serve Host/identity classification and all five desktop-only Goal refusals without exposing identity values. | Device/iOS version, redacted Serve loopback/no-Funnel status, request status plus `desktop_required`, unchanged Goal/approval/run rows for refusals, run IDs and screenshots for successful allowed actions. A request treated as local is a blocker. |
| Two physical masters              | Follow [two-master acceptance](LIVE_MULTIMACHINE_ACCEPTANCE.md): distinct stable IDs, one approval run per host, A outage and A revocation while B remains usable.                                                                                                                                                                                         | Two origins/IDs (redact private host details if needed), run IDs present only on the intended host, outage and independent-revocation results. Two processes on this one host do not qualify.                                                         |
| Release-build recovery            | On the checksummed release build with isolated test data, exercise HR-Q4 queued-before-start recovery and interrupt/resume a Goal. Relaunch the packaged Master; confirm persisted exact routes, one ordinary run at a time, no duplicate stage/broker action, and untouched user base until manual handoff.                                               | Before/after run and Goal IDs/status, redacted startup/event log and ledger counts, recovered stage sequence and base-branch commit comparison. Do not crash the user's live Master.                                                                  |

Codex current-code, Claude post-reset and ClinePass remain explicitly live-unvalidated. Optional OpenRouter/Jev live checks need separately authorized metered credentials/scope if enabled for release. No inference from unit tests closes any row above.

## Independent packaging review

Read-only Beam Free bridge job `5deece0dfb634bb89701fb730e29dce0`, session `ses_e8b4f17a2ffePmUSlYBZS9ylpC`, completed without timeout or changed files; reported catalogue cost-equivalent $0 (not an invoice). Supervisor assessment:

- Its claim that AGENTS.md is empty is false in the actual checkout; the reviewer sandbox did not expose the instructions faithfully. That claim is rejected and limits review coverage.
- Local generated `src-tauri/resources/app` was indeed stale RC1 material. It is ignored build output, not the RC3 package. Tauri's `beforeBuildCommand` always invokes `desktop:prepare`, which rebuilds and replaces the app/runtime tree; inspect the actual RC3 artifact before accepting contents. A scan of stale local staging is insufficient evidence.
- The package scanner intentionally skips symlink targets, binary/large-file text scans and several secret patterns. It detects recognized patterns only, not an exhaustive credential audit. Actual artifact inventory and symlink checks remain necessary.
- Windows lacks a duplicated JavaScript gate in its job, but `release-bundle` requires the Linux job, whose full gate is mandatory. This does not establish Windows unit-test compatibility; physical Windows acceptance remains pending.
- Legacy portable tar/zip scripts use install scripts; the RC3 workflow uses Tauri `desktop:prepare` with `--ignore-scripts` and bundles the target SQLite prebuild. The legacy scripts are outside this installer qualification.

No product change is justified by these findings alone. No tests were executed by the reviewer. Actual build and package evidence, not this review, determine installer qualification.
