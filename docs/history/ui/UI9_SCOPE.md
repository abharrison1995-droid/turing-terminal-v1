# UI.9 scope: Settings dropdowns and overlay hygiene (owner request)

Owner request: "clickable drop downs on settings, and ensure menus don't overlap." Constraints unchanged: dark tokens only, no colour literals, display face only on static allow-listed strings, 44px compact targets, reduced motion, accessible and keyboard operable, no server work, no Settings behaviour, payload or copy change, billing and approval behaviour untouched. No existing test is edited.

## UI.9a: Settings dropdowns

- New `src/client/pages/shared/SettingsCard.tsx`: a native `<details class="settings-card">` with a `<summary>` holding the existing title row plus a one-line summary, and a body wrapper. Controlled `open`; `onToggle` ignores programmatic changes. Contains no `<button`. The outer `<section class="surface-panel settings-section ...">` and its classes and aria-labels stay; each `<h2>` stays a literal, attribute-free element in its card's own source in the same order (pinned by `ui4Structure`).
- Defaults: Machine identity, OpenRouter, Global and project rules, Paired devices open; Provider integrations, Permission modes, Notifications, Desktop application, Tailscale readiness, Turing metered budgets closed.
- Summary lines use real loaded data only (names, counts, status words); never an invented value.
- Attention forces a card open (one-way, not persisted): a pairing request awaiting approval or a new pairing code; a Tailscale or desktop runtime error or a non-ready connection; a push notice; OpenRouter telemetry errors.
- Open state persists per viewer in `localStorage['tt.settings.sections.v1']` (validated JSON map, every read and write in try/catch, works without it). Stored value beats default; attention beats both.
- Children stay mounted while closed, so unsaved input, the pairing poll and QR generation are unaffected.
- CSS: reuse the `.settings-disclosure` look; add `.settings-card*` to the chevron selectors in `primitives.css`; summary at least `--h-touch`; tokens only.
- Heading access: verify `getByRole('heading')` inside `<summary>`; fallback is a `button[aria-expanded][aria-controls]` in the title row.

## UI.9b: overlay hygiene

- z-index scale in `tokens.css`: `--z-raised` 1, `--z-sticky` 10, `--z-menu` 20, `--z-topbar` 30, `--z-toast` 40, `--z-scrim` 50, `--z-drawer` 60, `--z-palette` 70, `--z-dialog` 80. Replace every raw numeric `z-index` in `styles/*.css`. The toast moves below the scrim and drawer (R1).
- R2: `useDismissibleDetails` for the Run actions menu: close on outside pointerdown, Escape (focus returns to the summary), focus leaving, and item click; opening one closes another.
- R4: studio nav top offset includes `env(safe-area-inset-top)`.
- R5: chart tooltip `left` clamped with `clamp()` so it never leaves the viewport.
- R6 (compact): sticky composer capped to the visible height with its own scroll.
- Palette versus drawer stays as is (regression test only).

## Evidence and acceptance

New tests only: `settingsCard.test.tsx`, source pins, `zScale` CSS test, `useDismissibleDetails.test.tsx`. New `e2e/ui9.spec.ts` at 1440, 390 and 375: open each overlay, assert zero bounding-box intersection between overlays visible together, every menu inside the viewport, `elementFromPoint` hits the overlay, Settings cards toggle and keep their content, attention opens. Captures in `docs/ui/evidence/ui9/after/` with `SHA256SUMS`. Full local gate; CI on push. NOT PERFORMED: physical iPhone, screen readers.

Existing tests that must stay green (pinned DOM): `ui4Structure` (h2 order, 18/9/2/1 control counts), `pagesStructure`, `ui4.spec`, `ui1c.spec`, `ui5.spec`, `ui7.spec`.
