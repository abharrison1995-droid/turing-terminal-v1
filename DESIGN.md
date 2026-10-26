# Design system: Turing Terminal

The shared React interface is a calm, native task workspace for desktop and phone. The owner's 2026-10-25 direction is the craft and clarity of Codex desktop/mobile, with **dark appearance only** (final owner preference, 2026-10-26). The 2026-10-26 refinement gives that workspace a restrained black-metal identity: ink-black ground, ash/bone lettering, iron-grey edges and a sparse oxblood brand accent. Product capabilities and authority boundaries remain in [PRODUCT.md](PRODUCT.md) and [AGENTS.md](AGENTS.md).

## Visual language

One native sans-serif family carries headings, labels and reading text. The bundled licensed UnifrakturCook blackletter face is reserved for the fixed `.brand-name` wordmark and the fixed home introduction heading only, through a dedicated `--font-brand` token. Geist Mono, bundled locally, is reserved for paths, model identifiers, commands, code and measurements. The historical licensed font assets remain provenance records and no network fonts are added. The wordmark sits beside the static licensed BrandSkull mark.

Use flat neutral surfaces, clear spacing, restrained borders and a compact type scale. Primary actions are high-contrast neutral bone fills. Green, amber and red indicate success, attention and failure; blue indicates progress or keyboard focus. Status always includes a word or icon and never relies on colour alone. Oxblood is a separate brand token and never indicates error, approval or online state. No gradients, fake distress, runes, illustrations, neon, red-everywhere, page-load choreography or ornamental typography.

`src/client/styles/tokens.css` owns all colour values. It contains one complete dark palette for surfaces, text, controls, status washes, diffs, charts, focus and overlays, with an ink-black canvas, ash/bone text, iron-grey edges and a sparse oxblood brand token. Contrast tests cover hover/pressed composites; disabled text is the documented exemption. The existing activity mascot retains its licensed pixel palette and always accompanies a textual state; it is not the navigation brand. Geometry uses 4/6/8/12px radii.

## Appearance

Use dark appearance consistently on desktop and phone, including when the operating system uses light appearance. Declare `color-scheme: dark`; browser/PWA metadata matches the dark canvas. There is no theme switch or appearance storage.

## Structure

- Desktop: a 248px quiet sidebar, 56px toolbar and bounded content region. Workspace navigation groups Projects, Grand Projects and Runs & history; configuration tools sit below recent tasks. Every existing destination remains directly reachable.
- New task: heading, pending approvals, composer, exact-route preview, setup actions, compact status links, task history and a disclosure for workflow/workspace detail. Visual and DOM reading order agree.
- Composer: task text leads; Project, Workflow and Options remain directly reachable. Stage configuration lives inside Options. Preview remains required before Start; simplifying the UI never starts work or widens permissions.
- Runs: a readable task thread with clear stage progress, approval/intervention actions and inspectable Activity/Changes content. Advanced logs and technical details use existing disclosures.
- Settings: one ordered column of controls and disclosures, with consistent spacing rather than a wall of equally weighted cards. Exact model configuration and billing disclosures remain available.
- Phone: drawer navigation, normal-flow home composer and 44px touch targets. The composer cannot float over approvals or hide setup actions. Run follow-up controls remain contextual. Respect safe-area insets and dynamic viewport height.

## Components and states

Buttons, fields, summaries, tabs, list rows and notices share tokens and state vocabulary across all pages. A border identifies a field; tone and spacing group content. Floating menus/dialogs/toasts use one soft elevation token. Keyboard focus uses a visible two-pixel outline. Preserve meaningful empty, loading, error, stale-data and disabled states.

Body text is 15px; controls 14px; metadata 13px; 12px is the floor. Input text on phones is 16px. Headings use 600 weight, controls 500 and body 400, supplied by the platform font. Use tabular numerals for usage and elapsed time. Long identifiers wrap or scroll within their own region, never the entire page.

Motion is brief feedback for interaction/state only, using 120–180ms transitions. No staged page-load sequence. Reduced-motion preferences disable animation. Existing z-index tokens retain overlay ordering.

## Verification

Run meaningful interaction tests for navigation, preview/start safety, approvals and the phone drawer. Verify dark palette contrast and that system appearance changes do not alter it. Inspect desktop and mobile screenshots together with deterministic API fixtures; fixtures prove browser layout, not physical phone capability or a live provider. Release status stays in [docs/V1_READINESS.md](docs/V1_READINESS.md).
