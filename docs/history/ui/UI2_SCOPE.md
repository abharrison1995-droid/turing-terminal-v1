# UI.2 scope: Home, New task composer, run preview, read-only run workspace

Governing: `UI0_SPEC.md` (UI.2, §12 R-1..R-4, §13, D-2, D-5), `AGENTS.md`, `UI1C_SCOPE.md`. Owner decisions are final: labels and routes unchanged (composer is "New task", page id `command`; no Overview or Reviews route); controls bind only to real backing fields; settings the server does not enforce are read-only or explanatory; no control or behaviour enables automatic paid fallback; run-draft persistence, file listing, editor, terminal, file tree and account menu stay deferred; `UnifiedApprovals` and its compact gating are reused, never reimplemented; Goal models untouched; no mascot; no fabricated progress.

Facts: `api.run(id)` returns `{run, effectiveRules, findings, decisions, gitOperations, events}`; stage `logs`/`output` live on `run.stages`; `api.diff` returns `{diff, truncated, cwd, message}` (the client does not read `truncated`/`message` today); there is no artifacts endpoint, so no artifacts tab.

## 1. Scope

New (client only): `pages/home/{LaunchBlockers,RunPreviewPanel,Safeguards}.tsx`, `pages/runs/{RunWorkspaceTabs,RunDiff}.tsx`, `pages/runs/diffModel.ts`, `styles/workspace.css` (imported from `index.css`).
Edited: `CommandCenter.tsx` (keeps `CommandCenter` and `RunGroup` exports), `RunsPage.tsx` (keeps `export function RunsPage` and `RunDetail`; `pagesStructure.test.ts` greps for them), `home.css`, `mobile.css`, `thread.css`, e2e fixtures and spec, `EVIDENCE.md`.

Home:

- Heading order: put `.home-intro` first in the DOM so the h1 precedes approvals; keep the desktop visual order with CSS `order`; on compact replace `display:none` with an sr-only pattern.
- `LaunchBlockers`: h2 "Before you can run" with an item count, `role="group"`, per-item action, 44px compact targets, `aria-describedby` from Run to the blockers (else `launch-hint`). Run stays enabled when only models are missing (the server preview stays authoritative). Warning conveyed by icon and word.
- `Safeguards`: a read-only strip (billing lane, provider lock, permission mode) with explanatory text, no interactive elements.
- Usage snapshot from `snapshot.usage` with its provenance word; real data only.
- Options controls and bindings are unchanged; layout only.
- Preview panel: heading follows `canStart` ("Ready to hand off" or "Setup needed before this can start"); focus moves to the heading when the preview appears (not on first render).

Run detail:

- `RunsPage` renders an sr-only h1 "Runs & history" when a run is selected.
- ARIA tabs Activity / Changes / Details (arrow, Home, End; 44px compact). Changes loads `api.diff` lazily on first activation; "View diff" selects it. Diff is split per file, with `+`/`-` markers and sr-only "added"/"removed" text, a `truncated` notice, the server `message`, a render cap with a visible notice, and a scrollable `tabIndex=0` pane.
- Details loading is `role="status"`; a failed `api.run` shows `role="alert"` "Run details could not be loaded" with Retry.
- Back link returns focus to the originating row.
- Fetching stays in `RunDetail`; props flow down. Counts come only from fetched array lengths.

Must not change: `src/server`, `src/shared`, `src/client/goals`, `api.ts`; nav labels, `Page` union, preview/start payload keys, billing default `subscriptions-only` and its options; run mutations (resume, stop, intervene, replay, duplicate, refinement confirm); Home h1 text.

Deferred: run drafts, file tree, editor, terminal, account menu, mascot, Goal-derived Home panels, artifacts tab, any fallback control. Pre-existing item flagged for the owner, not changed here: the Billing select already offers a "Custom metered lanes" option governed by `evaluateBillingLane`.

## 2. Acceptance matrix

| ID  | Criterion                                                                                                  | Evidence                   |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| A1  | First heading in Home is an h1 with approvals pending, at compact width                                    | homeCompose + ui2Css tests |
| A2  | Blockers are an h2 group with actions; Run is described by them                                            | homeCompose                |
| A3  | No paid-fallback control; payload keys and billing default unchanged                                       | guard tests                |
| A4  | Options controls on the real-field allow-list; Safeguards has no interactive elements                      | tests                      |
| A5  | Preview heading matches `canStart`; focus lands on it                                                      | tests                      |
| R1  | Run page has an h1; tabs ARIA and keys correct; diff loads lazily                                          | runWorkspace               |
| R2  | Per-file diff with non-colour markers; truncated notice; no fabricated progress                            | tests                      |
| R3  | Details loading and error states with Retry                                                                | tests                      |
| R4  | No new write controls; approvals not reimplemented                                                         | tests + git diff           |
| C1  | 44px compact targets; no colour literals; no display-face selector; motion only under reduced-motion guard | ui2Css + existing tests    |
| G   | Full gate green; CI under 30 min; empty diff for server/shared/goals/api.ts                                | gate                       |

## 3. RED tests (new files only; existing tests unmodified)

`pages/home/homeCompose.test.tsx`, `pages/runs/runWorkspace.test.tsx`, `styles/ui2Css.test.ts`, plus a pure unit test for `diffModel`. Assertions as in the matrix: first-heading h1; h2 blockers with count; `aria-describedby`; Run enabled with missing models; no control or option matching `/fallback|payg|auto.*paid/i`; previewRun payload has exactly the existing keys and billing default; Options allow-list; Safeguards has no button/input/select and follows the workflow's `billingMode`; usage provenance word; non-Ready heading when `canStart` is false; heading focus; run h1; tablist keys; lazy diff; per-file diff markers; truncated notice and empty message; run-error alert and Retry; no textbox or terminal/editor/save control; no progressbar or "%" for running runs; `UnifiedApprovals` rendered once; no `decideApproval` import in new files; back-link focus; CSS rules (no `display:none` on `.home-intro`, 44px compact, diff `overflow:auto`, `workspace.css` imported, no display face, no colour literals, no animation outside reduced-motion).

## 4. Evidence plan

`mockApi.ts` gains `:param` route fallback (exact keys win). Fixtures (labelled Fixture): `GET /api/runs/:id`, execution-operations, diff (3 files; truncated variant), `POST /api/runs/preview` (ready and not ready), stage logs on one failed and one running run; the snapshot's runs list is not altered so UI.1c captures stay reproducible. Captures at 1440x900 and 390x844 under `docs/ui/evidence/ui2/after/` with `SHA256SUMS` (about 14 PNGs, under 2 MB): Home with blockers, ready and needs-setup previews, Options open, failed-run Activity and Changes, running run, truncated diff, details error.

## 5. Risks

DOM reorder versus CSS `order`; tabs must not unmount fetched state; diff render cap; focus moves must not fire on first render; CI margin (keep about 35 lean tests); no physical iPhone, native Tauri or forced-colors check; fixtures only, never a live provider.
