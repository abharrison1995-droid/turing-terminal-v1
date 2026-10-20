# UI.1b scope and acceptance matrix

Stage: UI.1b (tokens, fonts, CSS primitive layer, `a11yTokens` rewrite, PWA meta). Base: `24bff6713f1f7840ac58ec96e515d5b33fc55c2b` on `ui/overhaul`. Governing text: [UI0_SPEC.md](UI0_SPEC.md) §6, §8, §12 (R-1 to R-4), §13.2, D-3/D-4/D-7/D-8. Not in scope: UI.1c shell and nav, the `Mascot` component and animation (UI.6), any feature, server, schema or Goal-model change. Planner: Sonnet 5.5 Medium. Contrast figures were computed by script by the planner and are re-verified by the tests below.

## 1. Scope

"Primitives" means the **CSS** primitive layer (`primitives.css` and the literal and `--white` usages in `base.css`, `shell.css`, `home.css`, `thread.css`, `pages.css`). No React primitive components are added in this stage: they would duplicate existing classes and collide with UI.1c. Value-level edits only; no DOM or layout change.

Files: `styles/tokens.css` (values and new tokens), `styles/fonts.css` (new, imported first from `index.css`), `base.css` (body gradient, selection, scrollbar), `primitives.css`, `shell.css` (topbar literal, `--white` uses, `.brand-name` display face), `home.css`, `thread.css`, `pages.css`, `phase36.css` (literal, 10px tick), `goals.css` (four diff literals at about 632-637 become `var(--diff-*)`, colour-only), `phase36.tsx` (chart hex to `var(--chart-N)`), `main.tsx` and `package.json`/lockfile (remove `@fontsource-variable/geist`; keep geist-mono), `index.html` (theme-color, color-scheme meta), `vite.config.ts` (manifest colours, glob adds `ttf`), `public/turing.svg`, `e2e/playwright.config.ts` (`colorScheme: 'dark'`), docs (`V1_READINESS` light-theme line, `DESIGN.md` superseded note, `docs/ui/EVIDENCE.md`).

Not touched: `tauri.conf.json` (CSP already `font-src 'self' data:`; a test pins it), `src-tauri/icons/*` rasters (known leftover), server, migrations, Goal models and TSX, goals tests other than `a11yTokens.test.ts`.

## 2. Tokens (values the tests enforce)

Dark only, `color-scheme: dark` once. Existing token names keep resolving; values change. `--white`, `--white-70`, `--white-45` are removed: `--field-hover`, `--on-accent`, `--qr-paper` (#ffffff, must stay white for QR scanning), `--badge-bg`, `--on-accent-line`.

Surfaces: `--canvas-top #050506`, `--canvas-bottom #16161a`, `--canvas-gradient` (vertical, used on body and `.app-shell`), `--canvas #08080a`, `--nav #0b0b0e`, `--surface #131317`, `--surface-2 #1a1a1f`, `--surface-3 #222228`, `--selected #2b2b33`, `--hover rgb(255 255 255 / 6%)`, `--pressed rgb(255 255 255 / 10%)`, `--scrim rgb(0 0 0 / 60%)`.

Text: `--ink #ecebe8`, `--ink-2 #c9c8c6`, `--ink-3 #b0afb5`, `--accent-ink #f68691`, `--ink-disabled #7c7b83` (documented exemption).

Accent (scarce): `--accent-fill #a81c2c`, hover `#961827`, pressed `#831422`, `--on-accent` white, `--accent #e0475a` (non-text identity colour, accepted caveat on pressed selected rows), `--accent-wash #2c1015`, `--focus-ring #ff8f99`, `--selection` dark crimson.

Status (text and wash): `--green #52c98a / #0e2a1b`, `--amber #e3ad3f / #2b2108`, `--red #ff7a66 / #2e1411`, `--info #6eaaf0 / #0e2236`. Failure red must differ from `--accent-ink` (hue gap at least 12 degrees) and failure always carries an icon plus a word.

Other: `--diff-add-ink #8fe3ae`, `--diff-add-bg #0f2b1b`, `--diff-del-ink #ffa79b`, `--diff-del-bg #331411`, `--chart-1 #5b9cf0`, `--chart-2 #3fbf8a`, `--chart-3 #e8924f`, `--line`/`--hairline` white alphas (about 14% and 8%), `--control-line #76767f`, `--scroll-thumb*`, `--topbar-bg`, `--focus-halo`, `--elev-float`, `--field`, `--field-hover`, `--badge-bg`.

Mascot tokens (token layer only): `--tt-mascot-outline rgb(20 20 24)` (decorative), `--tt-mascot-body rgb(188 188 192)`, `--tt-mascot-shade rgb(164 164 170)`, `--tt-mascot-accent rgb(188 48 60)`. Must equal the supplement values; accent tested against body only (3.06:1, thin margin, redundant cue).

Type: `--font-sans: 'Linux Libertine', Georgia, 'Times New Roman', serif`; `--font-display: 'UnifrakturCook', 'Linux Libertine', Georgia, serif`; mono unchanged. Scale (Libertine x-height about 0.43 em): `--fs-body 15`, `--fs-control 14`, `--fs-meta 13`, `--fs-micro 12`, `--fs-section 17`, `--fs-title 24`, `--fs-display-brand 22`, `--fs-display-title 30`; floors 14 body, 12 meta/micro; `--fw-medium 400`, `--fw-semibold 700` (only 400/700 ship, `font-synthesis: none`).

## 3. Fonts

Unchanged upstream TTFs, no subsetting, in `src/client/assets/fonts/`: UnifrakturCook-Bold.ttf (+OFL.txt), LinLibertine_Rah.ttf and LinLibertine_RBah.ttf (+OFL-1.1.txt, GPL.txt, LICENCE.txt, README), trimmed `font-provenance.json` with the supplement SHA-256 values. No Italic, no WOFF. Three `@font-face` blocks, `font-display: swap`, relative `url()`. PWA glob adds `ttf`; Workbox 2 MiB per-file limit unchanged (largest 807 KB). Precache before: 20 entries, 928,536 bytes (re-measure on a fresh build); after is recorded in `EVIDENCE.md`.

Display-face allow-list (fixed strings only): `.brand-name`, `.page-heading h1`, `.home-intro h1`, `.pairing-panel h1`, `.desktop-startup-card h1`. Excluded because they can carry user content: `.goal-mobile-heading h1` (goal title), the Runs `h2` with `shortTask(run.prompt)`, every other heading.

## 4. Tests

New: `styles/colourLiterals.test.ts`, `styles/typography.test.ts`, `styles/fonts.test.ts`, `pwaMeta.test.ts`; rewritten: `goals/a11yTokens.test.ts` (S2-S8 blocks kept verbatim; no `prefers-color-scheme`, `forced-colors` or `data-theme` rule is kept; adds the dark premise, the full contrast matrix with overlays composited, mascot checks and the failure-red rule). Existing tests that must stay unmodified: all other `goals/*`, including `completionCorrectionQualification` QF09, `goalMobile`, `mobileStanding`, `appShellCharacterization`, `App`, `phase36`, `appGoalsNavigation`, server tests.

## 5. Acceptance matrix

| ID  | Criterion                                                                                                                                        | Evidence                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| T1  | Dark premise: one `color-scheme: dark`, every surface luminance below 0.05, no theme switch rules                                                | `a11yTokens.test.ts`     |
| T2  | Text pairs at least 4.5:1 on every surface incl. hover/pressed composites; status on surfaces and washes; on-accent on fill variants; diff pairs | `a11yTokens.test.ts`     |
| T3  | Focus ring, control line, accent, chart colours at least 3:1 where specified                                                                     | `a11yTokens.test.ts`     |
| T4  | Mascot tokens equal the supplement; accent tested against body                                                                                   | `a11yTokens.test.ts`     |
| T5  | Zero colour literals outside `tokens.css` in CSS, TSX and `turing.svg` (hex, rgb, hsl, named); every `var(--x)` resolves                         | `colourLiterals.test.ts` |
| T6  | Display face only on the five selectors, no bare heading rule, PageHeading titles are literals                                                   | `typography.test.ts`     |
| T7  | Size floors, Geist sans removed, Libertine first in `--font-sans`                                                                                | `typography.test.ts`     |
| T8  | Font files, SHA-256, licences, relative `src`, `font-display: swap`, each under 2 MiB, `ttf` in the glob, CSP unchanged                          | `fonts.test.ts`          |
| T9  | `theme-color`, `color-scheme` meta and manifest colours equal the canvas token, not `#dce8f4`                                                    | `pwaMeta.test.ts`        |
| T10 | Reduced-motion global rule remains and comes after the keyframes                                                                                 | guard test               |
| G1  | No diff in server, shared, migrations, Goal models, existing goals tests                                                                         | `git diff --stat` review |
| G2  | Full gate green; hosted CI on the pushed SHA under 30 minutes                                                                                    | gate and CI              |
| V1  | Before/after captures at six viewports; two viewports per page committed under a size cap; written discrepancy notes; no pixel-perfect claims    | `docs/ui/evidence/`      |

## 6. Implementation record (added after review)

Five token values were tuned from section 2 so the strict contrast tests pass with hover and pressed overlays: `--accent-ink #f78e98`, `--red #ff8b7a`, `--info #77b0f1`, `--control-line #8b8b92`, `--accent #e14d60`. Section 2 shows the planner's first values; the final values and worst-case ratios are in [EVIDENCE.md](../../ui/EVIDENCE.md). `turing.svg` is the single allow-listed standalone asset (hex values must equal `tokens.css` values). `.desktop-startup-mark` uses `--accent-fill` because white on `--accent` is 3.87:1. Known low-severity test gaps from independent review: the display-face and literal scans do not catch a literal `font-family: UnifrakturCook`, CSS system colours or unquoted SVG attributes (none exist today).
