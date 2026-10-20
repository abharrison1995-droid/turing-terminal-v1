# UI.1c scope: AppShell, nav, responsive frame, states, command palette

Governing: `UI0_SPEC.md` (§2–§4, §7, §8, §12 R-1..R-4, §14 D-5, D-6), `AGENTS.md`. Owner decisions are final: nav labels/routes unchanged (Workflows, Projects, Grand Projects, Runs & history, Usage, Machines, Settings; composer "New task"); palette is navigation plus no-side-effect actions only; deferred: editor, terminal, file tree, account menu, run drafts; no server/schema changes; Goal models, `UnifiedApprovals` and compact-viewport gating untouched; no mascot.

## 1. Scope

New under `src/client/ui/shell/`: `navModel.ts` (NAV_ITEMS, pageTitle), `Sidebar.tsx`, `Topbar.tsx`, `NavGuardDialog.tsx` (JSX moved verbatim; state stays in App), `ConnectionBanner.tsx`, `CommandPalette.tsx`, `commands.ts`, `index.ts`; `styles/palette.css`. `ErrorState` is added to `pages/shared/parts.tsx`; `Loading` gains `role="status"`. `ui/shell` may import `pages/shared`; not the reverse. State, effects, `navigate`, `changePage`, `focusNextPageHeading` stay in `App.tsx` (must stay under 650 lines).

Visual: active nav item gets a 2px `--accent` bar (`.nav-link-active::before`); brand tile becomes `--surface-3` with `--accent-ink` icon (not a crimson fill); topbar gains the palette trigger; connection chip is dot+word on desktop and dot+sr-only word on compact; machine rail shows real connection state instead of hard-coded "Online". Hamburger gets `aria-expanded`/`aria-controls`; Esc closes the drawer and returns focus; `.app-main` is `inert` while the drawer is open. No bottom nav, no breadcrumb (deferred).

Must not change: labels/order/ids, `Page` union, landmarks (`aside[aria-label="Primary navigation"]`, `nav "Tasks"`, `nav "Workspace"`), accessible names ("Turing Terminal home", "New task", "Notifications"/"N pending approvals"), `aria-current` semantics, `.topbar-title` text, guard dialog role/ids/copy/trap/focus restore, poll/SSE/notification effects.

## 2. States (existing signals only)

- Loading: `role="status"`, `aria-live="polite"`.
- `ErrorState` (role alert, Retry) in the main area when `error && !snapshot && !loading`; banner suppressed then.
- `ConnectionBanner` "Showing last known data" when `error && snapshot`; keeps Retry and Restart Master (desktop).
- Pairing page behaviour unchanged. No invented revoked/offline detection; no `navigator.onLine`.

## 3. Palette

`role="dialog" aria-modal aria-label="Command palette"`; input `role="combobox"` with `aria-controls`, `aria-expanded`, `aria-autocomplete="list"`, `aria-activedescendant`; `role="listbox"`/`option`/`group`; empty result `role="status"` "No matching commands".
Keys: Ctrl/Cmd+K toggles (no Alt/Shift, ignore composing, ignored while guard dialog is open or pairing is required, `preventDefault`); Esc closes and restores focus to the invoker; arrows wrap, Home/End, Enter runs, Tab trapped. On run: close and restore focus first, then execute (so a guarded exit captures the correct invoker). `focusNextPageHeading` only when the page changes.
Registry (`kind: navigate | open-run | refresh`): the 7 destinations, "New task", up to 5 "Open run: …" from existing `railTasks`, "Refresh data" (GET only). Excluded: Restart Master, cancel/resume, approval decisions, all Goal commands/mutations, any save. `run` receives only `{navigate, openRun, refresh}`; no `api`/`goalApi`/`decideApproval` access. `PALETTE_COMMAND_IDS` is an `as const` allow-list. Compact: same list, full-width sheet, 44px rows, safe-area offset; trigger is a 44px icon button with `aria-keyshortcuts="Control+K Meta+K"`.

## 4. Acceptance matrix

| ID  | Criterion                                                     | Evidence                        |
| --- | ------------------------------------------------------------- | ------------------------------- |
| S1  | Seven destinations, labels and order unchanged                | existing characterization tests |
| S2  | Landmarks and accessible names preserved                      | existing tests                  |
| S3  | Nav guard works on all paths (sidebar, palette, bell, brand)  | appGoalsNavigation + new tests  |
| S4  | Esc closes drawer/palette/guard; focus returns to invoker     | new tests                       |
| S5  | Visible focus; 44px touch targets on compact                  | CSS test + Playwright           |
| S6  | Only the active bar adds crimson; no colour literals          | colourLiterals + shellCss test  |
| S7  | Loading, first-load error, stale banner and empty states      | new tests                       |
| S8  | Palette allow-list exact; no mutation; no restricted commands | new tests                       |
| S9  | `UnifiedApprovals`/Goal files untouched                       | `git diff --stat`               |
| S10 | Reduced motion respected; no new JS-driven animation          | existing guard                  |
| S11 | Full gate green                                               | gate                            |

## 5. RED tests

`ui/shell/commandPalette.test.tsx`, `paletteAllowList.test.ts`, `paletteNoMutations.test.tsx`, `shellFrame.test.tsx`, `styles/shellCss.test.ts` (assertions as in the matrix). Existing shell tests must not be edited; needing to edit one means the extraction was not behaviour-neutral.

## 6. Evidence

Add deterministic `e2e/fixtures/populated.ts` (projects, workflows, runs across statuses, approvals, goals, usage), labelled as fixtures. Capture Home, Runs, Grand Projects, Settings at 1440×900 and 390×844; plus palette (desktop and mobile), mobile drawer, guard dialog, first-load error, stale banner. Native Tauri, physical iPhone and forced-colors are not covered.

## 7. Risks

Ctrl+K browser/Tauri collision (documented gap); focus ordering with the guard; single `<main>`; crimson creep; CI margin (~25.5 of 30 min, keep tests lean).
