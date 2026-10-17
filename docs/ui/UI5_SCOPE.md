# UI.5 scope: mobile PWA (remote control only)

Governing: `UI0_SPEC.md` (UI.5, §12, §13), `AGENTS.md`, `UI1C` to `UI4` scope docs. Owner constraints are final: the phone is a remote control only; emulated checks at 375 and 390 px; physical iPhone and native checks stay "not performed" and are never claimed; `UnifiedApprovals` and compact gating unchanged; Goal completion, correction, attestation and final-apply stay absent on compact; no server work; no push or notification behaviour change; dark tokens, no literals, no display face; 44px targets; reduced motion; no mascot.

CI status: GitHub Actions is unavailable (billing). The local gate substitutes; EVIDENCE must say no CI run exists for the UI.3 to UI.5 SHAs.

## 1. Findings

- `index.html` lacks `viewport-fit=cover`, so iOS reports every `env(safe-area-inset-*)` as 0 and the existing safe-area CSS is inert.
- Compact breakpoints differ: `mobile.css` and `COMPACT_SHELL_QUERY` use 680px, `useCompactViewport` and `goals.css` use 640px. 375 and 390 are below both; the 641 to 680 sliver is recorded, not changed.
- Layout rules still use `vh`/`100vh` (`.palette` 80vh, `.run-diff-pane` 60vh, intervention textarea 28vh, `shell.css`, `pages.css`, `base.css`, `studio.css`); only `.home-column` uses `dvh`.
- The toast has no timer and sits fixed at the bottom on phone, covering the sticky composer's Start button.
- The manifest and service worker are adequate; the only icon is SVG. No new asset and no precache change are required.

## 2. Scope

CSS-first: add `src/client/styles/mobile-ui5.css`, imported last in `index.css`; rules sit in `@media (max-width: 680px)` unless they are `dvh` or `env()` fallbacks; tokens only.

1. Home: the "Before you can run" blockers move ahead of the recent list on compact, with explicit unique `order` values and a scroll margin so they are never hidden under the sticky composer.
2. Toast: on phone, top placement under the topbar plus safe-area inset; at most three lines with wrapping; 44px dismiss target.
3. Intervention box: no overlap with the last stage row (reserved padding, `scroll-padding-bottom`, above the home-indicator inset, `dvh` cap).
4. Diff pane: a visible horizontal-scroll signal (token edge fade or thin visible track), `overscroll-behavior: contain`, `dvh` max height. Any text hint is visual-only and redundant.
5. Palette: `max-height` in `dvh`; the hint sits outside the scroll area so the last row clears it; 44px rows kept.
6. Viewport units: `vh` to `dvh` with `@supports` fallbacks in `shell.css`, `pages.css`, `base.css`, `studio.css`; `scroll-padding-bottom` for sticky bars; rows get `min-width: 0` and `overflow-wrap`.
7. Safe area: left and right insets on topbar, page content and drawer.
8. Touch audit of Runs, Grand Projects, Usage, Machines, Settings and pairing; fix any miss with a targeted rule.
9. Motion stays inside `prefers-reduced-motion: no-preference` or the existing global reduction.

Approved small non-CSS changes, each with a reason:

- `index.html`: add `viewport-fit=cover` only (no `apple-mobile-web-app-*` tags; not required). `pwaMeta.test.ts` gains an assertion; the manifest and `vite.config.ts` do not change.
- Toast auto-dismiss: a new `src/client/useNoticeTimeout.ts` wired from `App.tsx` with a few lines. Non-error notices dismiss after `max(6000, 60 ms x length)`, capped at 15 s. Error toasts (the existing classification) never auto-dismiss. The timer pauses and resets on hover, focus, touch and pointer interaction. `role="status"`, the Dismiss button and every `setNotice` text are unchanged.

## 3. Must not change

`src/server`, `src/shared`, `src/client/api.ts`, `src/client/goals/*`, `useCompactViewport` and its gating, `UnifiedApprovals`, `vite.config.ts` manifest and workbox config, routes, buttons and roles, push and notification behaviour, the display-face allow-list. No colour literals, no light theme, no mascot. Existing tests stay unmodified.

## 4. Acceptance matrix

| ID  | Criterion                                                                                               | Evidence                                            |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| M1  | `viewport-fit=cover` present; `theme-color` unchanged                                                   | pwaMeta test                                        |
| M2  | No horizontal overflow at 375 and 390 on every captured page                                            | Playwright                                          |
| M3  | Compact targets at least 44px on the audited pages                                                      | CSS test + Playwright boxes                         |
| M4  | Toast does not intersect Start; error toasts persist; non-error toasts dismiss and pause on interaction | hook test + Playwright                              |
| M5  | Blockers reachable above the composer on phone Home                                                     | Playwright                                          |
| M6  | Intervention box does not overlap the last stage row                                                    | Playwright                                          |
| M7  | Diff pane signals horizontal scroll                                                                     | CSS test + Playwright                               |
| M8  | Palette last row clears the hint                                                                        | Playwright                                          |
| M9  | No `vh`/`100vh` in layout rules; `dvh` with fallbacks                                                   | CSS test                                            |
| M10 | Safe-area `env()` on topbar, composer, drawer, palette                                                  | CSS test                                            |
| M11 | Motion gated                                                                                            | CSS test                                            |
| M12 | Phone has no completion, correction, attestation or apply controls                                      | existing goalMobile and mobileStanding + Playwright |
| M13 | No colour literals; no display face                                                                     | existing and new CSS test                           |
| M14 | Protected paths empty diff; precache measured and recorded                                              | git diff, build                                     |

## 5. Tests

RED: `src/client/styles/mobileUi5Css.test.ts` (rules above), the `pwaMeta.test.ts` addition (new test in a new file instead of editing the existing one if needed), `src/client/useNoticeTimeout.test.tsx`. GUARD: no literals, no display face, no `display:none` on text, motion gated, error toast persists past 60 s, hover pause. Playwright, not CSS grep, proves layout: `e2e/ui5.spec.ts` at `iphone-375x812` and `iphone-390x844` with overflow assertions on every page. Keep unit tests lean.

## 6. Evidence

Captures under `docs/ui/evidence/ui5/after/` with `SHA256SUMS`: Home (with blockers), Runs list, run detail (running and diff), Grand Projects list and cockpit, Usage, Machines, Settings, pairing, palette, drawer, toast. Overflow assertion on every page; toast rect does not intersect the Start button. Chromium cannot emulate real safe-area insets; assert the computed rules only and label it "not verified on device". Record precache size before and after.

## 7. Physical-device checklist (NOT PERFORMED)

1. Add to Home Screen and confirm standalone launch. 2. Check notch and home-indicator insets on Home, the palette and the drawer. 3. Open the keyboard in the composer and the intervention box; confirm nothing is hidden. 4. Rotate to landscape and check the side insets. 5. Check 44px targets with a thumb. 6. Confirm a toast does not cover Start. 7. Confirm the diff scrolls by touch. 8. Pair by QR (also depends on the recorded QR completion-poll finding). 9. Confirm push behaviour is unchanged. 10. Check offline and service-worker update behaviour.

## 8. Risks

Home reorder versus existing order tests (run them first); `:has()` support on older iOS Safari (use a class hook if needed); `dvh` and `viewport-fit=cover` change iOS layout; toast timer flake under fake timers; Chromium is not WebKit; Playwright is not in CI; physical acceptance is pending.
