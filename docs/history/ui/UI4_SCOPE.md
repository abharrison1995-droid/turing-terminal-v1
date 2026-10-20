# UI.4 scope: Settings, device pairing, Machines, Usage

Governing: `UI0_SPEC.md` (UI.4, §12 R-1..R-4, §13), `AGENTS.md`, `UI2_SCOPE.md`, `UI3_SCOPE.md`. Owner constraints are final: labels and routes unchanged (Usage, Machines, Settings); real backing fields only; settings the server does not enforce stay read-only or explanatory; no control or behaviour enabling automatic paid fallback; `evaluateBillingLane` stays the single billing evaluator; usage provenance preserved and visible; one usage ledger; no account menu, no server work, no simulated controls; pairing behaviour and security unchanged (no cookies or tokens shown; the phone is a remote control only); desktop-only restrictions preserved; dark tokens only; 44px compact; reduced motion; no mascot.

CI status: GitHub Actions is unavailable (billing) when this stage is built. The local gate substitutes; no CI run exists for UI.3 or UI.4 SHAs until billing is restored, and EVIDENCE must say so.

## 1. Findings

- Pages are already split. Class names live in `pages.css`, `phase36.css`, `primitives.css`, `mobile.css`. All four pages already use `PageHeading` (h1) and `surface-panel` sections; only `DevicePairingPage` has its own `<main><h1>`.
- `UsageExplorer` (`phase36.tsx`) shows fixed provenance help strings; `UsageAggregate.tokenProvenance` (map of `UsageProvenance` to counts) is never rendered. `MeteredBudgetSettingsPanel` uses real `dailyUsd`, `monthlyUsd`, `warningRatio`, `timezone`, and `BudgetStatus` (`committedUsd`, `capUsd`).
- Machine profiles live in `localStorage` (`machineProfiles.ts`).
- The pairing POSTs send no body (`json('POST')`); the UI.0 spec expected a "bodyless-JSON fix" to be merged first and none was found. This is a base item, not UI.4 work; recorded as a limitation.

## 2. Scope

Default: CSS only. Add `src/client/styles/pages-ui4.css`, imported in `index.css` after `phase36.css` and before `goals.css`. Scope selectors by page (`.settings-*`, `.usage-*`, `.machine-*`, `.pairing-*`); shared primitives (`.surface-panel`, `.form-field`, `.status-pill`) are only touched through a page-level ancestor.

Approved additive presentational TSX (no logic, props, payload or copy change beyond the items listed):

1. `UsageExplorer`: a `ProvenanceBadge` rendering word plus count from `totals.tokenProvenance` (for example "Locally measured 128"); a null metric reads "Unavailable", never 0.
2. A budget meter (`role="img"` with an `aria-label`) from `committedUsd / capUsd` only when `capUsd` is non-null, always beside the text value; cap null renders "No cap" and no meter.
3. `className` hooks only where a selector is otherwise ambiguous, each with a recorded reason.

Visual changes: single-column reading width and `--s-*` spacing; section cards on `--surface`/`--hairline`; Settings grid two columns at 1100px and up, DOM order; Settings read-only rows as label/value pairs; device rows as cards with word-bearing status pills and 44px compact actions; long `tailscaleLogin`, origin and machine id wrap; Machines rows as cards with presence dot plus word, selected row keeps "selected" text; Usage tiles 4/2/1 columns with mono values, `usage-table` scrolls horizontally; pairing page as a centred card with controls at least `--h-touch`.

## 3. Must not change

`src/server`, `src/shared`, `src/client/api.ts`, `App.tsx`, `machineProfiles.ts`, `pairingQr.ts`, `goals/*`. No `api.*` call, payload key, input name, `autoComplete`, `onNotice` text, polling interval or QR URL clean-up changes. Nothing touches billing lanes or fallback; the OpenRouter "unused until you explicitly select it" notice and the existing "Custom metered lanes" option stay as they are. Credentials show only stored or not stored. `DesktopSettingsCard` and `isDesktopShell()` gating stay. No new button, link or role; no `--font-display`; no colour literals; no `display:none` on text.

## 4. Acceptance matrix

| ID  | Criterion                                                                             | Evidence         |
| --- | ------------------------------------------------------------------------------------- | ---------------- |
| S1  | `pages-ui4.css` imported after `phase36.css`; tokens only; no display face            | ui4Css           |
| S2  | Compact targets in the four pages at least `--h-touch`                                | ui4Css           |
| S3  | Settings grid 2+ tracks at 1100px and up, one below; Usage tiles 4/2/1                | ui4Css           |
| S4  | `.usage-table` scrolls; long strings wrap                                             | ui4Css           |
| S5  | Motion only under reduced-motion guard; no `display:none` on text                     | ui4Css           |
| P1  | Provenance word per figure; unavailable never shown as zero                           | usageProvenance  |
| P2  | Meter only when `capUsd` is non-null and always beside text                           | usageBudgetMeter |
| B1  | No fallback or auto-paid control in any of the four pages; billing payloads unchanged | ui4Structure     |
| B2  | Settings control inventory unchanged                                                  | ui4Structure     |
| K1  | Pairing: no token or cookie text; claim and complete payloads unchanged               | ui4Pairing       |
| K2  | Desktop-only controls absent on compact                                               | existing tests   |
| G   | Empty diff for protected paths; full local gate green                                 | gate             |

## 5. Tests (new files only)

`src/client/styles/ui4Css.test.ts` (RED while the CSS file is absent; GUARDs for literals, display face, motion, glyph content and `display:none`), `src/client/pages/ui4Structure.test.tsx` (GUARD characterisation of h1 and h2 inventories, Machines Connect/Remove rules, pairing states, no fallback text; RED for provenance word, "Unavailable" and the meter rules), `src/client/pages/ui4Pairing.test.tsx` (GUARD: claim called with `(code, deviceName)` or `(requestId, deviceName)`, complete without a code in QR mode, no credential text, `pairRequest` removed from the URL). Keep tests lean (about 35, no full `SettingsPage` renders where avoidable). Label each RED or GUARD honestly. Existing tests stay unmodified.

## 6. Evidence

`e2e/fixtures/ui4.ts` (labelled Fixture, typed with `satisfies`; merged as `ui4Routes`): quota envelope with forecast and a null/unavailable one; analytics with mixed `tokenProvenance` and a null metric; non-zero `committedUsd`; pairing requests (awaiting approval, expired) and a revoked device; an OpenRouter profile; machine profiles seeded through `addInitScript` into `localStorage` (online, offline, checking) with probes stubbed; a pairing-needed dashboard error and a QR variant. Captures at 1440x900 and 390x844 into `docs/ui/evidence/ui4/after/` with `SHA256SUMS` (under 2 MB): pairing (code entry, QR-detected), Settings sections, Usage (tiles, provenance, budget, envelopes), Machines. Assert: no fallback or auto-paid control, no horizontal overflow at 390px, no credential text, `api.unmapped` empty.

## 7. Risks

CI unavailable (local gate only; re-run when billing is restored); CI time margin; cascade through shared primitives; fixture shape errors; Machines probes need stubbing; not verifiable here: physical iPhone, native Tauri, forced-colors, live data.
