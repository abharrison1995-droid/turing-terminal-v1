# UI.3 scope: Grand Project / Goal cockpit (styling and layout only)

Governing: `UI0_SPEC.md` (UI.3, §12 R-1..R-4, §13), `AGENTS.md`, `UI2_SCOPE.md`. Owner constraints are final: Goal models and server untouched; no unqualified checkmark or "complete"; no fixed stepper; Goal-derived UI only from `goalApi` data; completion, correction, attestation and final-apply stay desktop-only with the existing compact gating (controls absent from the DOM on compact, not merely hidden); `UnifiedApprovals` reused; artwork never authorises fabricated progress; no mascot (UI.6); no new controls, roles, strings or server work; dark tokens only, no colour literals, display face only for static strings; reduced motion; 44px compact targets.

## 1. Findings that shape the plan

- All Goal styling is `src/client/styles/goals.css` (about 939 lines), tokens only. Import order in `index.css`: `…pages, mobile, phase36, goals, palette`.
- `a11yTokens.test.ts` (S2 to S6, T1, T10) and QF09 in `completionCorrectionQualification.test.tsx` parse `goals.css` with a flat rule regex (no CSS nesting). They pin: the compact `min-height: var(--h-touch)` rules for `.goal-completion-action button`, `.goal-completion-refusal button`, `.goal-completion-ack`; `.goal-completion button` wrapping rules; select/textarea width rules; exactly one distinct `color:` on each of `.goal-completion-contested`, `-invalid`, `-legacy` and none on `.goal-completion-completed`; the `.goal-confirm h2..h6` rule; no theme or forced-colors rules; the reduced-motion block after all keyframes. Do not reflow or split these rules.
- Goal tests are jsdom tests and never check layout; visual change is protected by CSS-grep tests and Playwright evidence only (CI does not run Playwright).
- `e2e/fixtures/populated.ts` has four goal list items and one unified goal approval, but no `/api/goals/:id*` detail routes, so the cockpit cannot yet render in Playwright.

## 2. Scope

CSS only. Add `src/client/styles/goals-cockpit.css`, imported in `index.css` directly after `goals.css`, holding additive layout and skin rules. Edit `goals.css` only where an existing rule must be overridden, never the pinned rules. No `!important`. TSX: none planned; a presentational `className` hook is allowed only with a recorded reason (no logic, text, props or role change). No DOM reorder.

Visual changes, via existing tokens and UI.1b/UI.2 primitives:

1. List: `.goal-row` as a card (`--surface`, `--hairline`, radius tokens); attention rows keep amber edge plus the "Needs you" text; status chips always carry a word; one column below 1024px.
2. Cockpit: header card in the reading face; two-column grid (main plus side rail) only at 1024px and up where the existing DOM allows it; single column on compact in DOM order.
3. Tabs: align with the UI.2 workspace tabs; active underline `--accent-fill`; 44px compact; horizontal scroll on narrow screens.
4. Lists (milestones, cycles, reviews, findings, evidence): spacing on `--s-*`; no progress bars, connectors or check glyphs; status as text plus chip.
5. Completion standing: spacing and framing via border and background tokens only; no extra `color:` declarations on the three pinned selectors.
6. Handoff, external integration, diff and path blocks: align with the UI.2 diff pane (`overflow:auto`, mono, `--diff-*`); long dynamic strings use `overflow-wrap:anywhere`.
7. Controls and confirm panels: spacing, wrapping, 44px compact.
8. Compact: single column; every interactive control in `.goals-page` at least `--h-touch`.
9. Motion: none added; any transition sits in `prefers-reduced-motion: no-preference`.

## 3. Must not change

`src/client/goals/*Model*`, `completionStanding*`, `completionModel*`, `correctionModel*`, `presentation.ts`, `controls.ts`, `refusal.ts`, `unknownOutcome.ts`, `goals/api.ts`, `useCompactViewport.ts`, `useLoad.ts`, all `goals/*.test.*`, `src/server`, `src/shared`, `src/client/api.ts`, `App.tsx`, `UnifiedApprovals.tsx`. No new button, link, role, `aria-*` or visible string. No `--font-display` on Goal selectors, no colour literals, no `display:none` on text or headings (sr-only only), no `prefers-color-scheme`.

## 4. Acceptance matrix

| ID  | Criterion                                                                           | Evidence                                                   |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| G1  | Goal CSS tokens only; no `--font-display`                                           | ui3Css + existing scans                                    |
| G2  | Pinned S2 to S6 and QF09 shapes hold                                                | existing tests, unmodified                                 |
| G3  | Compact: row, tab and control targets at least `--h-touch`; single column           | ui3Css                                                     |
| G4  | Two-column cockpit only at 1024px and up; no `display:none` on text                 | ui3Css                                                     |
| G5  | Status chips carry text; no content glyph (check marks) or "complete" in `content:` | ui3Css                                                     |
| G6  | No stepper, progress, meter or counter constructs                                   | ui3Css                                                     |
| G7  | Contested, invalid and legacy colour rules unchanged in count and distinctness      | existing S5, QF09                                          |
| G8  | Diff and code panes `overflow:auto`; long strings wrap                              | ui3Css                                                     |
| G9  | Animation or transition only in a reduced-motion guard                              | ui3Css                                                     |
| G10 | Control and heading inventory per Goal screen unchanged                             | ui3Structure                                               |
| G11 | 390px: no completion, correction, attestation or final-apply control in the DOM     | existing goalMobile, mobileStanding + Playwright assertion |
| G12 | Empty diff for the protected paths above; goals `*.tsx` diff empty or justified     | review                                                     |
| G13 | Full gate green; CI under 30 minutes                                                | gate                                                       |

## 5. RED and guard tests (new files only)

`src/client/styles/ui3Css.test.ts` (RED: new CSS file imported after `goals.css`; two-column at 1024px; compact `min-height: var(--h-touch)` on `.goal-row` and `.goal-tab`; tab `overflow-x:auto`; `overflow-wrap:anywhere` on title, branch and path containers. GUARD: no glyph content, no stepper constructs, no colour literals or display face in new files, no motion outside a reduced-motion guard, no `display:none` on `.goal-*` text). `src/client/goals/ui3Structure.test.tsx` (GUARD characterization: list and cockpit heading, link and button inventories; qualified contested copy with no unqualified "complete"; compact has no completion, correction, attestation or final-apply control; `UnifiedApprovals` rendered once). Label each test RED or GUARD honestly; most value is guards.

## 6. Evidence plan

New `e2e/fixtures/goals.ts` (labelled Fixture) merged as `ui3Routes`, with `/api/goals/:id` and its detail endpoints typed with `satisfies` against `src/shared/goalApi.ts`; learn the exact endpoints from the harness's unmapped-request list. Captures at 1440x900 and 390x844 into `docs/ui/evidence/ui3/after/` with `SHA256SUMS`: list; active cockpit with milestones in mixed statuses (no percentage); needs-user cockpit with pending approval; definitions tab; completion standing with caveats (contested, and unverifiable or legacy) from fixtures only; handoff tab with a diff or path block; 390px desktop-only gating (assert zero completion-action controls in the DOM). Record in EVIDENCE: Playwright is not run by CI; no physical iPhone, native Tauri, forced-colors or live-data check.

## 7. Risks

`a11yTokens` regex parser fragility (add rules in the new file; run `a11yTokens` after every step); cascade by order only; jsdom cannot verify layout; fixture shape errors yield error states rather than screenshots; the rail needs DOM support (otherwise stay single column, no reorder); CI time (last run 26 minutes of 30, so keep new tests lean and avoid full cockpit RTL renders).
