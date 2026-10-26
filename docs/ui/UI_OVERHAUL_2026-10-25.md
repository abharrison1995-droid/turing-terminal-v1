# Native task workspace overhaul

Owner direction, 2026-10-25: simplify the shared desktop/phone UI to the craft and interaction standard of Codex desktop/mobile. The final 2026-10-26 preference is **dark appearance only**, prioritizing starting tasks, following progress and handling approvals. [DESIGN.md](../../DESIGN.md) replaces the older crimson, serif/blackletter packet.

## Source and scope

- Branch: `codex/ui-overhaul-2026-10-25`, based on qualification commit `5dd8d740589f8e81a3a9e71bb445aab7a4d4e9bd` and merged master `6e5119f7e59220f8a825cefecf9b28b578e8bbb0`.
- Implementation commit: `f1ca311d6868125f134c2ba4d845fc63410eda76`. The full gate runs against this application/test source; following evidence edits are documentation-only.
- Shared React/CSS, PWA metadata and acceptance tests only. No server/shared engine, migration, provider credential, live Master configuration, billing evaluator or Goal authority change.
- Version remains `1.0.0-rc3`. Existing master installers do **not** contain this overhaul. No tag, publication or merge into master is authorized by this work.

## Result

- Native sans typography and a complete neutral dark palette for controls, notices, diffs, charts, overlays and focus. Semantic colour remains attached to real status. Dark appearance stays dark under either system preference; there is no theme switch or appearance storage.
- Sidebar separates workspace destinations from tools and gives recent tasks room. Every destination and the existing guarded navigation remains accessible.
- Home leads with the task and actionable approvals. Exact assignments remain in Options and the preflight preview; background workflow/workspace metadata uses a disclosure. Phone composition stays in normal flow and cannot dock over approvals or setup actions.
- Settings becomes one ordered directory. Workflow Studio keeps its stage editor and billing controls; an idle saved footer stays in flow, while changes/errors retain the save affordance. Phone task rows give status and elapsed time a second line rather than squeezing titles.
- Task preview/start, approvals, Goal completion/handoff and remote authority boundaries are preserved. Acceptance coverage is retained; obsolete design assertions now match the owner's new direction. Contrast checks no longer need the old selected-row exemption.

## Browser evidence

Command: `npx playwright test -c e2e/playwright.config.ts e2e/overhaul.spec.ts`.

**Final result, 2026-10-26: 3 tests passed in 58.8 seconds; 20 dark captures.** It exercises the real React UI in Chromium at 1440×900 and 390×844: Home, Projects, Grand Projects, Runs & history, Workflows, Usage, Machines, Settings, an active task thread and active Goal detail. Assertions cover one main heading, no document/content horizontal overflow, visible phone controls with at least 44px touch targets and matching DOM/visual Home order. A separate test checks that light/dark system preferences and reload retain dark appearance with no mutation API calls or Theme control.

Every `/api/*` response is an invented fixture. Fixture dates/labels in images are not current operational data. The desktop/phone matrices recorded 85/82 GET requests, zero mutations, zero unmapped requests and zero page errors. Current dark captures and request records are ignored local artifacts under `artifacts/ui-overhaul-2026-10-25/`; older light captures there are superseded. Six representative dark captures (1,141,948 bytes total) are committed with [SHA-256 checksums](evidence/overhaul-2026-10-25/SHA256SUMS):

- [Desktop Home](evidence/overhaul-2026-10-25/desktop-dark-home.png) and [phone Home](evidence/overhaul-2026-10-25/phone-dark-home.png).
- [Settings](evidence/overhaul-2026-10-25/desktop-dark-settings.png) and [Workflow Studio](evidence/overhaul-2026-10-25/desktop-dark-workflows.png).
- [Phone task thread](evidence/overhaul-2026-10-25/phone-dark-thread.png) and [phone Goal](evidence/overhaul-2026-10-25/phone-dark-goal-detail.png).

Visual QA was bounded to an initial desktop/phone batch and a correction/confirmation batch. Corrections removed leftover CSS reading-order rules, improved narrow task rows and returned the idle workflow save bar to flow. Harness completion corrected exact-name selectors for rows with badges and excluded collapsed disclosure children from touch measurements. The later owner preference removed light appearance and its controls; only affected evidence/acceptance is refreshed. Browser installation used Playwright's Chromium fallback for the host OS; this is browser evidence, not physical-device evidence.

## Independent review

Read-only OpenCode Go **Beam Free**, exact `opencode-go/beam-free`, job `fd70c65d536c41c2a7d722f5e5e00217`, completed in about 66 seconds; reported cost equivalent **$0**, no fallback or timeout. It changed no files. The supervisor removed redundant Runs/Goals badge logic from the tools-only navigation group. A suggested Home/Runs draft-guard bypass was not reachable: the existing guard applies when leaving the currently mounted Goals/Workflows page, while those callbacks are mounted on Home/Runs. Guarded shell navigation remains covered. Appearance-hook observations are superseded by its removal following the owner's final preference. Tablet crowding was speculative, not a reproduced defect; no tablet or native claim is made. Final dark-only focused review `324070e464964314929f425821f0ddd9` timed out after 120 seconds without findings; reported cost equivalent was $0. No paid fallback was used. The bounded retry `94549351ce054a759c8defdc94eba10d` then completed on the final committed dark-only source with no actionable defects and no file changes; reported cost equivalent was $0. The reviewer ran no tests; software/browser/native evidence is independently recorded below. The earlier timeout is retained as provenance, not an approval.

## Validation

The complete gate passed on 2026-10-26 against application/test source `f1ca311d6868125f134c2ba4d845fc63410eda76`: `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (**232 files, 4,118 tests, 1,403.25 seconds**), `npm run build`, `npm audit --omit=dev` (**zero vulnerabilities**) and `npm run docs:links` (**94 Markdown files**). Additional `npm run typecheck:e2e` passed. The build retains one non-failing large-chunk warning and the historical unused licensed font assets. The final frontend JS hash matches both actual Linux packages.

[Machine-readable validation](evidence/overhaul-2026-10-25/validation.json) records exact UTC start/end times and exit codes. Complete local logs are retained under ignored `artifacts/ui-overhaul-2026-10-25/validation/`. Format/links are rerun after these documentation-only evidence edits. An earlier in-progress full suite and AppImage build were stopped when the owner revised the appearance preference; their partial output is not a pass. Targeted final dark-token/PWA/Settings tests also passed: 4 files, 66 tests.

## Local Linux package check

A disposable source export was used for `npm ci` and `npm run desktop:build:linux`, with `CARGO_BUILD_JOBS=2`. The final dark-only Tauri binary, DEB and AppImage were produced successfully on 2026-10-26; both were collected with `npm run desktop:release`. The 569-file source manifest is compared by SHA-256 against implementation commit `f1ca311d6868125f134c2ba4d845fc63410eda76`; no input drift is accepted. Local per-file provenance is retained under ignored `artifacts/ui-overhaul-2026-10-25/native-source.json`.

The actual final DEB was extracted with `dpkg-deb --extract`. Its 8,721-file resource payload passed `scripts/scan-package.mjs` (recognized-pattern coverage only), contains bundled Node `v22.23.1` and only `linux-x64.node` for SQLite. The bundled runtime/compiled Master started with fresh disposable `TT_DATA_DIR`, `TT_HOST=127.0.0.1`, an unused `TT_PORT`, `TT_APP_VERSION=1.0.0-rc3` and restricted PATH. GET-only checks passed health/version, manifest, dark-only metadata and byte-identical served frontend assets containing the new heading and no appearance-preference code. No provider or mutation API call was made. See [smoke evidence](evidence/overhaul-2026-10-25/linux-deb-smoke.json). Actual installer [SHA-256 checksums](evidence/overhaul-2026-10-25/SHA256SUMS-linux.txt) are recorded; binaries, inventories and logs are retained under ignored `artifacts/ui-overhaul-2026-10-25/native-linux/`.

The actual AppImage was extracted with `--appimage-extract`. Its frontend is byte-identical to the actual DEB and its compiled Master matches the prepared source. `linuxdeploy` adds `$ORIGIN` RUNPATH to the Node/SQLite ELF files, so direct byte equality with the prepared native inputs is not expected. The actual extracted AppImage runtime and SQLite passed startup and the same GET-only health/manifest/asset smoke with separate disposable data. Both payload scans passed. See [AppImage evidence](evidence/overhaul-2026-10-25/appimage-payload.json). The disposable build and extraction directories were removed after retaining real artifacts and verifying source hashes.

This is a local **glibc 2.39** build, not the Ubuntu 22.04 CI portability baseline. The system install/uninstall and desktop WebView smoke script is not run: it installs a system package and refuses to run while the user's existing Master occupies its port range. The user's staging, caches and live Master remain untouched. Extracted-runtime smoke does not establish installed-shell, physical-display or recovery acceptance. Hosted Windows packaging/smoke passed as recorded below; physical Windows acceptance remains pending.

## Hosted CI qualification

[PR #16](https://github.com/abharrison1995-droid/turing-terminal-v1/pull/16) was qualified at evidence head `cb7eb2dc8e67a64b1b7af58c209c7c0d1c3d992b`. [CI run 40250749045](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40250749045) passed every gate: 232 files/4,118 tests in 704.30 seconds, zero production audit vulnerabilities and 94 Markdown files. Actual checkout was GitHub's synthetic PR merge `d0c472a20d8164cdf2e896ce5c60ec44bb36c603` over master `6e5119f`; this did not merge the PR into master.

The manually dispatched [installer run 40250764420](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40250764420) uses branch head `cb7eb2d`. Windows passed native NSIS build, quiet install, app startup/health/PWA and uninstall. Its actual artifact `12621136079` was downloaded, ZIP digest verified, installer extracted with `7z`, and resource payload scanned: 8,721 files, Windows Node PE and only `win32-x64.node`. Frontend JS is byte-identical to both local Linux packages. [Windows payload evidence](evidence/overhaul-2026-10-25/ci-windows-payload.json) records exact hashes and provenance. Ubuntu 22.04 also passed its full gate (232 files/4,118 tests in 1,247.43 seconds), native DEB/AppImage builds and installed/portable Master health/PWA smoke. Combined collection/upload passed. Actual CI Linux resources were extracted/scanned with only `linux-x64.node`; bundled Node is `v22.23.3`, and frontend hashes match Windows and both local packages. See [CI Linux payload evidence](evidence/overhaul-2026-10-25/ci-linux-payloads.json).

Combined artifact `12621149192` expires 2026-11-02 01:12:33 UTC. Its ZIP SHA-256 and all three installer hashes matched the manifest; the Windows binary also matches the separately inspected intermediate artifact. See [CI checksums](evidence/overhaul-2026-10-25/SHA256SUMS-ci.txt) and [verification](evidence/overhaul-2026-10-25/ci-release-verification.json). Local copies are retained under ignored `artifacts/ui-overhaul-2026-10-25/ci-release/`. These Ubuntu baseline artifacts are separate from the local glibc 2.39 packages above. Later qualification evidence commits change documentation only; the UI implementation remains `f1ca311`.

## Remaining physical/release actions

These checks require actual devices and a new build of the final integrated commit. They remain pending alongside the canonical [V1 readiness gates](../V1_READINESS.md):

1. Windows/Linux installed shell: record OS, installer hash and commit; confirm dark appearance under both system settings, relaunch, navigate with the keyboard and inspect a real task/approval. Attach screenshots and defects.
2. iPhone PWA over Tailscale: record iOS/build/origin identity, pair, open the drawer, type with the software keyboard, approve/intervene, reconnect after locking and verify notifications. Attach screenshots and operation IDs; confirm no obscured action.
3. Rebuild and qualify the exact release commit after integration approval. Master RC3 installer checksums attest `6e5119f`, not this UI. Two-master isolation, installed crash/recovery and Goal resume remain in the existing release checklist.

This evidence does not establish live-provider capability, physical phone/native behavior, WCAG conformance or release readiness.
