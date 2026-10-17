# UI programme evidence

Evidence for UI stages. UI approval is for development only; none of this marks V1 release-ready.

## UI.1b: dark tokens, fonts, CSS primitive layer, PWA meta

- **Scope and matrix:** [UI1B_SCOPE.md](UI1B_SCOPE.md). See the CI and review record at the end of this section.
- **What changed:** dark-only token set (`tokens.css`); three unchanged upstream TTFs with their licences under `src/client/assets/fonts/`; `fonts.css`; the display face on five fixed selectors only; colour literals moved into `tokens.css` (8 CSS, 3 chart, icon values); Geist Sans removed (Geist Mono kept); `theme-color` and manifest colours; `color-scheme: dark`; Playwright pinned to dark. No server, shared, migration, Goal-model or Tauri change.
- **Mascot:** only the four `--tt-mascot-*` tokens and their contrast tests are in this stage. The `Mascot` component and animation are UI.6.

### Precache measurement (method: sum the `url:` entries of `dist/sw.js` against `dist/`)

|                    | Entries | Bytes                    |
| ------------------ | ------- | ------------------------ |
| Before (`86b1e63`) | 20      | 928,536 (904.24 KiB)     |
| After              | 18      | 2,450,344 (2,390.30 KiB) |

Growth is about +1.52 MB, from the unsubsetted TTFs (UnifrakturCook 42,688; Libertine Regular 806,856 and Bold 748,600), less the five Geist Sans WOFF2 files. The largest file is 807 KB, under Workbox's 2 MiB per-file limit. Converted WOFF would save about 0.8 MB but needs the OFL conditions in UI0_SPEC §13.2 item 7; that is an owner decision if the size is a problem.

### Tuned token values

The planner's first values failed the spec's own thresholds under hover and pressed overlays; five were brightened minimally (hue kept) and the tests were not weakened:

| Token            | Planned   | Final     | Worst case after                           |
| ---------------- | --------- | --------- | ------------------------------------------ |
| `--accent-ink`   | `#f68691` | `#f78e98` | 4.53:1 (selected, pressed)                 |
| `--red`          | `#ff7a66` | `#ff8b7a` | 4.50:1; hue gap to accent-ink 13.4 degrees |
| `--info`         | `#6eaaf0` | `#77b0f1` | 4.52:1                                     |
| `--control-line` | `#76767f` | `#8b8b92` | 3.03:1                                     |
| `--accent`       | `#e0475a` | `#e14d60` | 3.01:1 (surface-3, pressed)                |

Known: `selected` under the pressed overlay has luminance about 0.0525; the dark-premise test bounds opaque surfaces only.

### Screenshots (deterministic Playwright harness, fixtures only, dark pin)

Before and after, 1440×900 and 390×844, for Home, Runs, Settings and Grand Projects, under `docs/ui/evidence/ui1b/` with `SHA256SUMS` (1.1 MB total, under the 2 MB cap). The other four viewports (1920×1080, 1280×800, 1024×768, 375×812) were captured and inspected but are not committed (D-9, size). Fixtures are empty or stub data: Settings and Grand Projects show empty states, and the Settings "fixture_missing" notice is a missing fixture, not product behaviour. The before images use the previous light theme.

Observed discrepancies (not pixel-perfect claims; no packet mockup is in the repository, so no side-by-side was made):

- The overall look is near-black with a restrained crimson accent; the wordmark and fixed titles use UnifrakturCook; body text uses Linux Libertine; code stays monospace.
- Libertine renders visibly smaller than Geist at equal size, so the scale was raised (body 15, meta 13). Dense screens (Runs with data, Workflows) are not exercised by the empty fixtures and need a populated visual pass in UI.7.
- The sidebar active item and nav badges rely on `--selected`, not the accent bar shown in the packet; the packet's red active bar is a UI.1c shell matter.
- On mobile the Home page still lists Recent above the heading (existing layout, not changed here).
- The brand tile still uses the accent colour at full strength; judge against accent scarcity in UI.1c.
- Not performed: any physical iPhone, native Tauri, Windows or forced-colors check. The focus ring, native form-control chrome and scrollbars were not exercised beyond the static captures.

### CI and review record

- **Review:** fresh independent Sonnet 5.5 review of `86b1e63..0474057`: APPROVE, no blocking findings. Low findings: `on-accent` on `--accent` was 3.87:1 for the desktop-startup mark (fixed in `35b6192` by using `--accent-fill`); scope doc lacked the tuned values (recorded); display-face and literal scans have known gaps, none exploited today; red and accent-ink differ by 13.4 degrees of hue and similar luminance, so failure always needs an icon and a word.
- **Tested source:** `35b6192f9c42ca4b0f5ff353c817c7fc4e9f6c05` on `ui/overhaul` (push event; the checkout log shows this exact SHA, no merge commit).
- **Run:** https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/38815726948, conclusion success, 2026-10-15 22:14:25Z to 22:40:00Z (about 25 min 35 s of the 30-minute budget; the margin is small).
- **Gates:** `npm ci`, `format:check`, `lint`, `typecheck`, `npm test` (173 files, 3,471 tests), `build`, `npm audit --omit=dev` (0 vulnerabilities) all passed.
- **Limits:** this CI run does not execute Playwright or `typecheck:e2e`; the e2e harness ran locally. Later docs-only commits are not themselves CI-tested until pushed.

## UI.1c: shell, states and command palette

Scope: `docs/ui/UI1C_SCOPE.md`. Planner: Sonnet 5.5 Medium. RED tests: Haiku 5.5 High (commit `46b94fd`). Implementation and review fixes: Haiku 5.5 High. Independent review: fresh Sonnet 5.5 Medium, verdict APPROVE WITH FIXES; all six findings fixed (Restart Master on first-load error, `<main>` landmark for Loading/ErrorState, palette dialog focus, palette closed on pairing, drawer reset on widen, combobox `aria-expanded`), covered by `src/client/ui/shell/shellReview.test.tsx`.

One RED test was corrected, not weakened: `paletteNoMutations.test.tsx` re-pressed the toggle shortcut on an already-open palette, which closes it. The helper now presses Escape after reading the labels; every assertion is unchanged.

Screenshots: `docs/ui/evidence/ui1c/after/` (14 PNGs, `SHA256SUMS`), generated from deterministic fixtures (`e2e/fixtures/populated.ts`, names prefixed "Fixture"), not live data.

Known limitations:

- Fixture stages have no model, so Home shows the "Set up the stage models first" warning.
- No run-detail capture yet (needs a run fixture; UI.2).
- Phone palette: the fifth recent-run row may sit under the hint line; scrolling not yet verified (UI.5).
- Compact Home opens with an h2 rather than an h1 (existing heading structure; revisit in UI.2).
- Settings captures show only the first viewport; Usage, Workflows, Projects, Machines not yet captured in populated state.
- Ctrl/Cmd+K collision with browser or Tauri shortcuts is untested outside jsdom.
- Physical iPhone and native checks: NOT PERFORMED.

UI.1c CI: run 38830237379, event push, tested exact `ff4dcc546866b69c128d256effb9107a4aaa8b8b`, conclusion success, 00:34:26Z to 00:47:00Z (about 12.5 minutes).

## UI.2: Home composer, run preview, read-only run workspace

Scope: `docs/ui/UI2_SCOPE.md`. Planner Sonnet 5.5 Medium; RED tests `7f5863a` (38 tests, 29 RED); implementation and review fixes Haiku 5.5 High; independent review fresh Sonnet 5.5 Medium: APPROVE WITH FIXES, all findings fixed (invented Details empty states, diff refresh for active runs, "View diff" focus, rename/quoted-path and cap handling in `diffModel`, stale-details alert, compact CSS order tie, preview notice copy, error icon+word) with 22 new tests. No change under `src/server`, `src/shared`, `src/client/goals` or `src/client/api.ts`. No paid-fallback control added; Safeguards is read-only; the pre-existing "Custom metered lanes" billing option is untouched and flagged for the owner.

Captures: `docs/ui/evidence/ui2/after/` (18 PNGs, `SHA256SUMS`) from labelled fixtures. The UI.1c PNGs were deliberately not regenerated; they remain the UI.1c record and differ from a rerun because Home changed.

Known limitations (not fixed in UI.2):

- Notices (toast) never auto-dismiss and can cover the heading or Start controls on phone.
- On phone the "Before you can run" group sits below the recent list; the composer is sticky.
- The running-run intervention box appears docked over stage content on phone (read from a screenshot, not measured).
- Diff lines clip on phone with no visible hint that the pane scrolls.
- No artifacts tab (no endpoint), no run drafts, file tree, editor or terminal (deferred).
- No physical iPhone, native Tauri or forced-colors check; CI does not run Playwright.

UI.2 CI: run 38840346275, event push, tested exact `5ba015804f4d8c986aa1a3d26ac245461b6c323b`, conclusion success, 02:25:24Z to 02:51:40Z (about 26m16s of the 30-minute budget; margin is small).

## UI.3: Goal cockpit (styling and layout only)

Scope: `docs/ui/UI3_SCOPE.md`. Planner Sonnet 5.5 Medium; RED and guard tests `8ea5fa1` (22 tests: 7 RED, 15 GUARD); implementation Haiku 5.5 High; independent review fresh Sonnet 5.5 Medium: APPROVE WITH FIXES, fixed (compact list-row spacing cascade, a positive control for the phone "no completion controls" test, active-tab hover, comments). The change is CSS only (`goals-cockpit.css` plus one `@import`); `git diff` is empty for `src/server`, `src/shared`, `src/client/api.ts` and `src/client/goals`. Pinned `a11yTokens`/QF09 rules are untouched.

Captures: `docs/ui/evidence/ui3/after/` (11 PNGs, `SHA256SUMS`) from labelled fixtures (`e2e/fixtures/goals.ts`). Desktop and phone cover the list, active and needs-user cockpits; phone covers contested and legacy standing; desktop covers the Definitions tab, Handoff tab and completion standing. The phone spec asserts that completion, correction, attestation and apply controls are absent from the DOM, with a desktop positive control.

Limitations:

- The two-column layout applies to the cockpit header only: the DOM has no side rail and no DOM reorder was allowed.
- The desktop completion-standing fixture is not fully consistent: the handoff Goal's detail still reports the final-apply completion check as failing and external verification as "not integrated" beside a recorded attestation. These are fixture values, not product behaviour, and the capture does not show a successful completion.
- `goalHandoff.test.tsx` has a known timing flake under full-suite load (one failure in one local full run, passing alone and on rerun).
- Playwright is not run by CI; no physical iPhone, native Tauri or forced-colors check; fixtures only.

## UI.4: Settings, device pairing, Machines, Usage

Scope: `docs/ui/UI4_SCOPE.md`. Planner Sonnet 5.5 Medium; tests `befcb65` (36 tests: 14 RED, 22 GUARD); implementation Haiku 5.5 High; independent review fresh Sonnet 5.5 Medium: APPROVE WITH FIXES, fixed (phone padding cascade, budget meter fill neutral, fixture and spec comments and assertions). The review also caught my own instruction to override the pairing title's display face; that override was removed because `.pairing-panel h1` is an allow-listed static fixed title.

Changes: `pages-ui4.css` (page-scoped, tokens only) plus one `@import`; the only TSX change is presentational, in `phase36.tsx` (`ProvenanceBadge` and `BudgetMeter`). Provenance words and counts come straight from `tokenProvenance`; a missing metric reads "Unavailable", never 0; the meter renders only when `capUsd` is non-null and always beside its text. `git diff` is empty for `src/server`, `src/shared`, `src/client/api.ts`, `src/client/goals`, `src/client/App.tsx` and `src/client/pages`. No billing, fallback or credential change.

Captures: `docs/ui/evidence/ui4/after/` (18 PNGs, `SHA256SUMS` verified) from labelled fixtures.

Findings and limitations:

- **Owner decision, QR pairing:** `DevicePairingPage.tsx:22` returns early from the completion effect when `code` is empty, and `code` is never set in QR mode, so a phone that claims through a QR request never polls `completePairing` and appears to wait indefinitely after desktop approval. A one-line candidate fix (`if (!requestId || (!code && !qrRequestId)) return;`) worked in a scratch copy only. UI.4 forbids logic changes, so nothing was changed and the test was removed. QR claim remains an untested Tailscale row.
- The pairing POSTs still send no body; the UI.0 spec expected a "bodyless-JSON fix" to be merged first and none was found.
- `MachinesPage.tsx:133` static copy mentions a "pairing cookie" (copy only, no value).
- The OpenRouter "Store" buttons sit slightly off their fields; pairing requests still show raw "Awaiting_approval" copy (a TSX copy change, out of scope); the revoked device is shown as an expired fixture.
- The 44px control minimum applies at all widths.
- **CI not run:** GitHub Actions is unavailable (billing) for the UI.3 and UI.4 commits; only the local gate has run. Playwright is not run by CI in any case. No physical iPhone, native Tauri or forced-colors check.

## UI.5: mobile PWA (remote control only)

Scope: `docs/ui/UI5_SCOPE.md`. Tests: RED and GUARD in `d32ad79`, unchanged. Review fixes are covered by the new file `src/client/ui5Review.test.tsx` (31 tests); the committed `useNoticeTimeout.test.tsx` and `mobileUi5Css.test.ts` are not modified and still pass. Changes: `src/client/styles/mobile-ui5.css` (compact block, tokens only), `src/client/useNoticeTimeout.ts`, the toast markup in `App.tsx`, and `e2e/ui5.spec.ts`.

Review fixes:

- **Timer release.** `onPointerCancel` and `onTouchCancel` release the pointer and touch sources. `onPointerLeave` releases hover and pointer. `App.tsx` already spreads the handlers onto the toast, so no further wiring was needed.
- **Failure classification.** `isErrorNotice` keeps the three original rules ('could not', 'before', 'not available') and adds whole-word failure terms: failed, did not, cannot, can't, stopped, unable, denied, error, rejected, refused.
- **Preview-ready success.** A notice that starts "Run preview is ready" is not an error because of its "before starting" wording. It stays an error if it also reports 'could not', 'not available' or a failure term. The literal rule (always false for that prefix) would hide a real failure that begins with the same words, so the narrower rule was used. "Preview loaded. Setup is needed before this can start." stays an error.
- **Toast clamp.** Status toasts clamp to three lines. Error toasts are not clamped: their text scrolls inside a box capped at 30dvh, so no failure text is cut off.
- **Same-text re-notice (known limitation, not fixed).** The timer restarts only when the notice text changes. Setting the same status text again while a toast is showing does not restart it, so it clears on the first schedule. A fix needs a notice identity (a counter or key) alongside the text; the text itself was to stay unchanged, so this is recorded for a later pass.
- **Backdrops.** `.palette-backdrop` and `.nav-guard-backdrop` take left and right `env(safe-area-inset-*)` inside the 680px block. The palette sheet has its own inset as well, so a landscape notch is inset twice. Not verified on a device.
- **Diff pane fade.** A mask fade at the inline (right) end, using the `--surface` token. It is always on and does not follow scroll position, so it also shows on a short diff. Left-to-right layout only.
- **Usage switcher.** A 3-column grid on compact. "Custom" now shares its row with "30d" and "This month" at 375 and 390 px.
- **Machines.** Connect and Remove already measure 44px tall with the same centre line (0 px difference at 375 and 390 px), so no CSS was changed. The spec now asserts it.
- **Home cushion.** A 16px bottom padding on `.home-column`, under the docked composer. Before the cushion, the composer sat at its natural position at the end of the scroll with nothing under it, so the cushion guards the edge rather than fixing an existing overlap. The scrolling element is the window. The cushion moves the Home background behind the drawer scrim; the drawer capture changed for that reason, confirmed by removing the cushion for one run.
- **Palette `@supports`.** The desktop `dvh` values equal HEAD's `vh` values where the two units match, which is every desktop window. Measured at 1440x900: backdrop padding-top 108px (12vh of 900) and palette max-height 480px (min(480px, 70vh) is 480px at 900px). The phone `80dvh` changes only where browser chrome moves the viewport.

Captures: `docs/ui/evidence/ui5/after/`, 32 PNGs at 375x812 and 390x844: the 14 earlier captures plus `toast-preview` and `home-end`. Three full runs of `e2e/ui5.spec.ts` (30 tests each) produced identical hashes, and `SHA256SUMS` was refreshed from them. Captures use fixtures only. Chromium reports every `env(safe-area-inset-*)` as 0.

Precache (method: `vite build` at HEAD in a scratch export, and in the working tree; `sw.js` reports the total): HEAD 18 entries, 2420.39 KiB; UI.5 18 entries, 2424.71 KiB (+4.32 KiB).

Not verified: physical iPhone (not performed); WebKit; notched or landscape safe areas; CI (GitHub Actions unavailable, so no CI run exists for the UI.3 to UI.5 SHAs).

UI.5 review: fresh Sonnet 5.5 Medium, APPROVE WITH FIXES, all fixed as above. The physical-device checklist is in `docs/ui/UI5_SCOPE.md` §7 and is NOT PERFORMED. Also known: the UnifiedApprovals banner shows plain "Approve" and "Deny" on the phone (existing, protected behaviour); the phone "no completion controls" assertion covers Goal and cockpit controls only.

## UI.6: mascot status marks

- Scope `docs/ui/UI6_SCOPE.md`; RED tests `2c8617a`; implementation committed after independent review (APPROVE WITH FIXES, all required fixes applied).
- Shipped: idle, thinking and loading animations only (18 frames, `frames.generated.ts` 16.8 KB, provenance in `docs/ui/MASCOT_PROVENANCE.json`). Wipes and the phase-transition animation are deferred by owner decision (no truthful trigger).
- Placements, each with adjacent visible text and `aria-hidden` art: Loading (48 px), Home composer preview pending (24 px), run detail while `run.status === 'running'` (24 px), empty Runs state (idle). Not in Sidebar, startup mark, alerts, dialogs, approvals or Goal UI. No success or failure art. Reduced motion shows the static first frame with no timers.
- Deviation for owner sign-off: the running mark is in the run detail only, not on every Runs list row (avoids many concurrent timers).
- Cost: precache +14.26 KiB (2424.71 to 2438.97 KiB). Phone composer is 32 px taller permanently (44 to 76 px) because the status slot is reserved to avoid layout shift; owner may prefer a truncated label.
- Gate (local, exit 0 each): format:check, lint, typecheck, build, `npm test` 201 files / 3760 tests (one `goalHandoff` timing flake on the first run, passes on rerun and alone).
- Captures: `docs/ui/evidence/ui6/after/` (33 PNGs incl. frame strips; 24 Playwright tests at 1440, 390, 375; identical hashes across two runs).
- CI: none run for the UI.3 to UI.6 SHAs (GitHub Actions billing block).
- NOT PERFORMED: physical iPhone, native Tauri window, screen readers, phone battery, forced-colors. Licence of the supplement mascot art is unconfirmed; owner to confirm before merge.

## UI.7: qualification

- `e2e/ui7.spec.ts`: 71 cells (66 route x viewport, 4 palette, 1 drawer) with populated fixtures; two runs identical (hashes and RESULTS.md). Results and allow-listed exceptions (ellipsis truncation, intentional fixture console errors, existing "No metered route may run" policy copy) are in `docs/ui/evidence/ui7/RESULTS.md`. No open findings.
- Captures: `docs/ui/evidence/ui7/after/` (34 PNGs, 6.6 MB; full six-viewport set was 14 MB so desktop 1440 and 390 cover every route and the other viewports cover Home, run detail and the Goal cockpit).
- NOT PERFORMED: axe contrast scan (no dependency), drawer scrim close, physical iPhone, native Tauri, screen readers, forced-colors, live data, CI.

## UI.8: final review notes

- Final independent review of `67af34f..b7b0bec`: APPROVE, no blocking findings.
- Checksum locations: `SHA256SUMS` is at the stage root for ui1b, ui1c and ui2, and inside `after/` for ui3 to ui7.
- `.github/workflows/ci.yml` was changed in UI.1b to also trigger on pushes to `ui/**` (no other CI change; the 30-minute timeout is unchanged).
- `src/client/goals/a11yTokens.test.ts` was migrated from light-theme to dark-token assertions in UI.1b (owner-approved theme); contrast checks were broadened, with one declared exemption (pressed selected row for `--accent`).
- Status: implementation complete with physical acceptance pending. V1 is not declared release-ready; V1 blockers are unaffected by this programme.

## CI record: UI.3 to UI.8 stack

- Run 39046711892 on `c72f582129a9460bde62a614ddfedf645a332023`: success (format, lint, typecheck, test, build, audit all green), 2026-10-17 15:49 to 16:11 UTC (about 22 minutes of the 30-minute budget). This covers UI.3 to UI.8 together; there is no per-stage CI for those. The earlier billing block is resolved.

## Pairing fix (owner-reported: no QR to pair)

- Root cause: `call()` in `src/client/api.ts` sent `content-type: application/json` on every request, including the bodyless pairing POSTs. The server (Fastify 5) rejects that with 400 `FST_ERR_CTP_EMPTY_JSON_BODY`, so "Create pairing code" failed and no code or QR was produced. Approve and deny were affected the same way. The server tests did not catch it because `app.inject` sends no content type.
- Fix: the JSON content type is only declared when a body is sent. Second fix: `DevicePairingPage` returned early from the completion poll when `code` was empty, so after a QR claim the phone never completed pairing; it now polls whenever a request id exists and either a QR request or a code is present.
- Tests (new files only, RED before the fix): `src/client/apiBodyless.test.ts`, `src/client/pages/qrPairingCompletion.test.tsx`.
- This supersedes the earlier "QR completion poll" and "bodyless-JSON" limitations recorded in UI.4. Not yet verified on a physical phone or against the live desktop app (the running app was not restarted). The QR still requires an HTTPS Tailscale Serve origin with no path in the Settings field.

## Brand skull (owner request)

- The sidebar brand icon is now the static first idle frame of the approved skull (`src/client/ui/shell/BrandSkull.tsx`): no timers, `aria-hidden`, token colours, "Turing Terminal" as adjacent text. This is a logo, not a status mark. The UI.6 placement guard allow-list gained this one file by owner request. The startup "TT" tile and `public/turing.svg` are unchanged.
- The UI.7 captures were regenerated to show it (`docs/ui/evidence/ui7/after/`, checksums refreshed); earlier stage captures keep the old icon as their record.

## Skull app icon and favicon (owner request)

- `public/turing.svg` (PWA icon, favicon) and `src-tauri/icons/{32x32,128x128,128x128@2x}.png` plus `icon.ico` now show the first idle skull frame on the dark tile, generated by `scripts/generate-brand-icons.py`. `index.html` gained `<link rel="icon" href="/turing.svg">`. The `--tt-mascot-*` tokens were rewritten from `rgb()` to the equal hex values so the standalone icon can use token colours (values unchanged; token tests still pass).
- Not verified: how the icon looks on a real taskbar, installer, home screen or browser tab. iOS home-screen icons need a PNG touch icon; none exists, so this was not changed. The desktop app and installer need a rebuild to pick up new icons.
