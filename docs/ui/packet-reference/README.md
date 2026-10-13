# Turing Terminal UI handoff

## Start here

This package collects the UI concepts and mascot sheets created in the design conversation. It is a visual handoff, not an implementation or a claim that every depicted workflow or status is live.

### Current design references

1. `visuals/ui/overview-dashboard.png` - preferred desktop app shell and overview.
2. `visuals/ui/new-task-provider-routing.png` - prompt composer and provider/model selection.
3. `visuals/ui/workbench-agent-run.png` - editor, run timeline and Goal Engine context.
4. `visuals/ui/goal-engine-cockpit-refined.png` - Goal Engine cockpit presentation. The first pass is retained for comparison.
5. `visuals/mascot/skull-status-atlas-simplified.png` - preferred simple, square, grey skull mascot direction.
6. `visuals/mascot/skull-directional-wipes-six-visible-poses.png` - preferred directional wipe transition concept.
7. `visuals/mood/black-metal-forest-atmosphere.png` - mood reference only; do not use as a literal page background.

The earlier status skull and first wipe atlas are included as history, not the preferred current versions.

## Visual direction

- Background: black to dark charcoal gradient, with layered near-black panels and clear separation between editor, navigation and contextual rails.
- Accent: deep crimson for active navigation, primary actions, progress and important status. Keep red scarce enough to retain meaning.
- Mascot and neutral UI: ash grey, stone grey and off-white. Avoid orange in the skull mascot.
- Display typography: use a blackletter / medieval Gothic face only for the brand mark and large graphic titles, based on the user's supplied visual reference.
- Reading typography: Linux Libertine for normal interface text, as selected by the user: https://font.download/font/linux-libertine
- Code: use a legible monospaced editor font. Do not use the decorative display face for code, dense navigation, small labels or long paragraphs.
- Overall feel: metal-inspired atmosphere with the spacing, hierarchy, information density and interaction clarity expected of a polished desktop coding assistant. Keep ornament restrained and utility high.

## Screen intent

- Overview: app-wide orientation, current work, recent workspaces and concise status.
- New Task: prompt entry plus explicit provider/model routing and run safeguards.
- Workbench: code/editor area, run activity, review state and contextual project information.
- Goal Engine cockpit: progress and checkpoint presentation. Treat status details in the concept art as illustrative.

## Mascot and motion direction

The simplified skull atlas is the preferred mascot direction: a compact square silhouette, simple dark eye sockets, very little facial detail, and small red status signals. The status sheet concept groups idle, thinking, loading and phase-progress loops by row.

The current wipe concept has six rows and six visible poses per row: left-to-right, right-to-left, top-to-bottom, bottom-to-top, horizontal center-out, and vertical center-out. The last pose is a tiny remnant; hide the mascot immediately after that pose. Suggested use: short single-pass wipes for phase changes, looping loading only while work is active, and a static/resting state when idle. Respect reduced-motion preferences and avoid flashing or continuously pulsing red.

## Implementation cautions

- These are concept images. Text, model routes, charts, usage values, checkpoints, PR references and statuses shown inside them are illustrative and may be stale. Replace them with live application data and verify against the current repository before implementing.
- The PNG sprite atlases are visual layouts, not guaranteed production-ready sprite maps. Before wiring them into code, verify cell bounds, consistent alignment, alpha edges and frame order. The displayed art includes soft edge haze in places; remove it if it creates unwanted halos over the app gradient.
- Keep the visual asset separate from motion logic. The app should decide which mascot state to show based on real task/phase status.
- Use accessible contrast, keyboard focus states, reduced-motion behavior and responsive layouts. Keep animations purposeful and short; never make a loading state imply progress that the workflow cannot substantiate.
- The supplied design reference image and font file are not bundled here. Only the generated concepts and selected font URL are included.

## Asset inventory

See `asset-manifest.json` for exact file paths, source names, pixel dimensions, alpha-channel presence and hashes. The PDF in this package gives a visual overview and summarizes the handoff notes.
