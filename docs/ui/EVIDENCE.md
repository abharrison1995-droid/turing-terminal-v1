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
