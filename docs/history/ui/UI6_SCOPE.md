# UI.6 scope: mascot integration (status marks only)

Governing: `UI0_SPEC.md` (UI.6, §12, §13), `AGENTS.md`, `UI1C` to `UI5` scope docs. Owner constraints are final: D-4 approved skull art, supplied states only; inline SVG on a 24x24 grid, 96x96 frames, binary alpha; the mark is `aria-hidden` and always has adjacent status text; never inside alert, dialog or approval regions; static first frame under reduced motion; 48 px on desktop, 24 or 48 px on mobile; tokens `--tt-mascot-*` only; states derive only from real signals; no success or failure art; no Goal UI.

CI status: GitHub Actions is unavailable (billing). The local gate substitutes; EVIDENCE must say no CI run exists for the UI.3 to UI.6 SHAs.

## 1. Scope

- `src/client/ui/mascot/frames.generated.ts`: provenance header (supplement identity, manifest sha256, generator, data sha256). Only the idle, thinking and loading animations (18 frames). Each frame is 24 strings of 24 characters over `.obsa` (transparent, outline, body, shade, accent). At most 20 KB raw.
- `scripts/generate-mascot-frames.mjs` (developer tool, not in the gate) reads the supplement directory from an argument and emits the TS plus `docs/ui/MASCOT_PROVENANCE.json` (sha256 of every source SVG, manifest and wipe mask counts, row-4 note).
- `playback.ts`: pure `frameIndexAt`, injected `MascotClock`, `useMascotFrame` (one timeout per frame, paused while `document.hidden`, frame 0 and no timers under reduced motion, single-pass `onDone` support).
- `mascotState.ts`: pure selectors returning `loading | thinking | idle | null` from existing signals only; no `goals/` import; completed, failed and cancelled give `null`.
- `MascotStatus.tsx`: props `animation`, `size: 24 | 48 | 96`, required non-blank `label` (throws otherwise). `<span class="mascot-status"><svg aria-hidden="true" focusable="false" data-mascot/><span class="mascot-status-label">label</span></span>`. Merged `<path>` runs per colour, `var(--tt-mascot-*)` fills, no title, role or filter. The index exports only `MascotStatus`.
- `styles/mascot.css` (imported in `index.css`): fixed slot, 24 and 48 sizes only, `image-rendering: pixelated`, no colour literals.

## 2. Placements (conservative)

| State    | Source                          | Adjacent text                     | Place                                           |
| -------- | ------------------------------- | --------------------------------- | ----------------------------------------------- |
| loading  | existing `loading && !snapshot` | "Connecting to the local master…" | `Loading` in `parts.tsx` (replaces the spinner) |
| thinking | preview request pending         | "Preparing run preview…"          | Home composer, 24 px                            |
| thinking | `run.status === 'running'`      | existing "Running · elapsed"      | Runs row, 24 px                                 |
| idle     | Runs empty state                | the existing empty-state copy     | Runs `EmptyState` only                          |

Not in the Sidebar, startup mark, `ErrorState`, `NavGuardDialog`, `UnifiedApprovals`, any `role=alert`/dialog or `goals/`.

## 3. Deferred (owner deferral, not an omission)

- Wipes and the phase-transition animation: no truthful trigger, risk of a "mascot vanished" signal read as completion, extra precache. Hashes and the row-4 glitch note stay in the provenance record.

## 4. Must not change

`public/turing.svg`, the colourLiterals allow-list, blackletter branding, `goals/`, server, shared, `vite.config.ts`, `package.json`, Sidebar and Topbar markup, token values. Existing tests stay unmodified (a one-line Loading characterisation change is allowed only if it asserts the old spinner icon, and must be reported).

## 5. Acceptance matrix

| ID  | Criterion                                                                           | Evidence                  |
| --- | ----------------------------------------------------------------------------------- | ------------------------- |
| A1  | Frame data matches manifest counts, timings and provenance hash; 24x24 over `.obsa` | mascotFrames              |
| A2  | Playback timings via injected clock; unmount cancels; hidden pauses                 | mascotPlayback            |
| A3  | Reduced motion: frame 0, zero timers                                                | mascotPlayback            |
| A4  | Label required; aria-hidden; no role/title/aria-label                               | mascotStatus              |
| A5  | Only allow-listed files import the mascot; none in forbidden regions                | mascotContexts            |
| A6  | Selectors never produce art for completed/failed/cancelled                          | mascotState               |
| A7  | Sizes 24/48 only; token-only colours; no literals                                   | mascotCss, colourLiterals |
| A8  | Generated module at most 20 KB; precache delta recorded                             | gate                      |

## 6. Evidence

`e2e/ui6.spec.ts` at 1440, 390 and 375: loading, preview pending, running row, empty Runs, reduced-motion statics, plus a per-animation frame strip using Playwright's fake clock. DOM assertions on aria-hidden, visible text and no layout shift. Screenshots are evidence, not pixel gates. NOT PERFORMED: physical devices, native window, screen readers, phone battery, CI.

## 7. Risks

Licensing: no licence file covers the supplement art; it is the owner-approved D-4 redraw, provenance recorded, owner to confirm before merge. Accent contrast 3.06:1 (redundant cue; text carries state). Idle loop pauses while hidden. `thinking` must clear on settle and rejection.
