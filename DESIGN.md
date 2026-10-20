---
name: Turing Terminal
description: A calm, technical task workspace for supervising coding agents. Dark only. Desktop is the IDE, the phone is the cockpit.
colors:
  canvas: '#08080a'
  canvas-top: '#050506'
  canvas-bottom: '#16161a'
  nav: '#0b0b0e'
  surface: '#131317'
  surface-2: '#1a1a1f'
  surface-3: '#222228'
  selected: '#2b2b33'
  field: '#1a1a1f'
  ink: '#ecebe8'
  ink-2: '#c9c8c6'
  ink-3: '#b0afb5'
  ink-disabled: '#7c7b83'
  control-line: '#8b8b92'
  accent: '#e14d60'
  accent-fill: '#a81c2c'
  accent-fill-hover: '#961827'
  accent-fill-pressed: '#831422'
  accent-ink: '#f78e98'
  accent-wash: '#2c1015'
  on-accent: '#ffffff'
  focus-ring: '#ff8f99'
  green: '#52c98a'
  green-wash: '#0e2a1b'
  amber: '#e3ad3f'
  amber-wash: '#2b2108'
  red: '#ff8b7a'
  red-wash: '#2e1411'
  info: '#77b0f1'
  info-wash: '#0e2236'
typography:
  display-title:
    fontFamily: "'UnifrakturCook', 'Linux Libertine', Georgia, serif"
    fontSize: '30px'
    fontWeight: 700
  display-brand:
    fontFamily: "'UnifrakturCook', 'Linux Libertine', Georgia, serif"
    fontSize: '22px'
    fontWeight: 700
  title:
    fontFamily: "'Linux Libertine', Georgia, 'Times New Roman', serif"
    fontSize: '24px'
    fontWeight: 700
    lineHeight: '32px'
  section:
    fontFamily: "'Linux Libertine', Georgia, 'Times New Roman', serif"
    fontSize: '17px'
    fontWeight: 700
    lineHeight: '24px'
  body:
    fontFamily: "'Linux Libertine', Georgia, 'Times New Roman', serif"
    fontSize: '15px'
    fontWeight: 400
    lineHeight: '22px'
  control:
    fontFamily: "'Linux Libertine', Georgia, 'Times New Roman', serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: '20px'
  meta:
    fontFamily: "'Linux Libertine', Georgia, 'Times New Roman', serif"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: '18px'
  mono:
    fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
    fontSize: '0.92em'
    fontWeight: 400
rounded:
  sm: '6px'
  md: '8px'
  lg: '12px'
  xl: '16px'
  pill: '999px'
spacing:
  1: '4px'
  2: '8px'
  3: '12px'
  4: '16px'
  5: '20px'
  6: '24px'
  8: '32px'
  10: '40px'
  12: '48px'
components:
  button-primary:
    backgroundColor: '{colors.accent-fill}'
    textColor: '{colors.on-accent}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: '36px'
  button-primary-hover:
    backgroundColor: '{colors.accent-fill-hover}'
  button-primary-pressed:
    backgroundColor: '{colors.accent-fill-pressed}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: '36px'
---

# Design System: Turing Terminal

The source of truth in code is `src/client/styles/tokens.css`. If this file and `tokens.css` disagree, `tokens.css` wins and this file is out of date. This document describes the intent behind the tokens. The contrast, typography, font and colour-literal rules are enforced by tests (`src/client/goals/a11yTokens.test.ts` and `src/client/styles/*.test.ts`).

## Overview

**North star: The Task Thread.** One workspace in which a task is a thread: you describe it, agents work on it, you answer when they need you. Desktop is the IDE (orchestration, configuration, inspection). The phone is the cockpit (start, watch, approve, intervene), reached through the same components in a different arrangement, not a shrunken desktop.

Character: dark, quiet and technical, with a scarce crimson accent and a blackletter wordmark. Dense where useful, never a dashboard.

Hierarchy: application canvas → navigation → workspace → object → control. Typography, spacing and tonal change come before borders. A card is an object, not a layout primitive.

## Colors

The app is dark only. There is one `color-scheme: dark`, no light palette and no theme switch.

- **Canvas and nav**: near-black. The body and app shell use a vertical black-to-charcoal gradient (`--canvas-gradient`). Navigation sits one step above the canvas.
- **Surface, surface-2, surface-3**: the raised work surface, its quieter sibling for chips and nested groups, and a pressed or selected-soft tone. Hover and pressed are white overlays (`--hover`, `--pressed`).
- **Ink, ink-2, ink-3**: three text levels. All pass 4.5:1 on every surface, including hover and pressed composites. `--ink-disabled` is the one documented exemption.
- **Accent (crimson)**: `accent-fill` carries primary actions (white text). `accent` is a non-text identity colour (brand marks, selection marks). `accent-ink` is for text actions. The accent is never a status colour and never used for destructive actions.
- **Status**: red = failed, green = completed, amber = assistance required, `info` = running. Each has a wash for tinted backgrounds. Failure red is kept visibly distinct from the crimson accent, and failure always carries an icon plus a word. State is never shown by colour alone.

### Named rules

- **The Accent Budget.** At most one crimson fill per view region: the Run button, Approve once, Resume run, Save. If two crimson fills compete, one is wrong.
- **The Three Signals Rule.** Colour marks failure, completion and a request for the user. Informational notes stay neutral.
- **Borders Are Last.** Prefer a tone step, then spacing, then a hairline. Inputs keep a 3:1 border (`control-line`) because they must be findable.
- **No Literals.** Colour values exist only in `tokens.css`. CSS, TSX and `public/turing.svg` reference tokens (the SVG must use the same hex values as the tokens).

## Typography

- **Reading face:** Linux Libertine for all UI text.
- **Display face:** UnifrakturCook, used only on the brand wordmark and five fixed titles (`.brand-name`, `.page-heading h1`, `.home-intro h1`, `.pairing-panel h1`, `.desktop-startup-card h1`). It never appears on user content such as Goal titles or run prompts, in navigation, labels, tables or code.
- **Mono:** Geist Mono for commands, branches, model and provider ids, hashes, logs and code.

All fonts are bundled locally, so the app works offline in the PWA and the Tauri shell. Only weights 400 and 700 ship, with `font-synthesis: none`. Elapsed time, tokens, costs and counts use tabular numerals.

Scale (size/line height in px):

| Role          | Size/line |
| ------------- | --------- |
| Display title | 30        |
| Brand         | 22        |
| Title         | 24/32     |
| Section       | 17/24     |
| Body          | 15/22     |
| Control       | 14/20     |
| Meta          | 13/18     |
| Micro         | 12        |

Micro is the floor, used for badges, counters and chart ticks. The composer input and phone form fields use 16px, which prevents mobile zoom.

## Layout and spacing

4px/8px rhythm (`--s-1` to `--s-12`). Desktop page width 1280, padding 32, sidebar 264, topbar 52. Controls are 36px (28 compact, 40 large); every control on a phone is 44px.

## Elevation and stacking

One elevation level only (`--elev-float`) for floating UI: menus, toasts, the phone drawer, the docked phone composer and the sticky follow-up bar. On dark surfaces it pairs an inner light edge with a shadow. Cards, panels and the desktop composer are flat. Every `z-index` uses a `--z-*` token, ordered: raised, sticky, menu, topbar, toast, scrim, drawer, palette, dialog.

## Shapes

Radii: 6 (chips, kbd), 8 (controls, rows), 12 (panels), 16 (composer, bubbles), pill (counts, glance chips, status pills).

## Motion

Durations are 120, 160 and 180 ms with one easing curve. A global `prefers-reduced-motion: reduce` rule disables animation. The skull mascot (`src/client/ui/mascot/`) plays only for real activity (idle, thinking, loading, phase transitions). It always sits next to a text status, never replaces an error, warning or approval, and shows a static first frame under reduced motion.

## Components

- **Buttons**: primary (crimson), secondary (surface with a line border), quiet, danger (red wash), text (accent-ink), icon (36px, 18px glyph). States: hover, pressed, focus-visible (focus ring), disabled, `aria-busy`.
- **Fields**: 36px, 1px `control-line`, focus ring in the accent. Checkboxes and toggle lines use `accent-fill` as their accent colour.
- **Status pill**: tonal fill, no border. Running shows a pulsing dot.
- **Rows**: one interactive-row recipe for runs, projects and templates; hairline separators only inside lists and tables.
- **Disclosure**: one chevron, one summary pattern (`settings-disclosure`), used for advanced settings everywhere.
- **Notices**: neutral by default; amber and red tints only for assistance and failure.
- **Composer (signature)**: the largest object on Home. Textarea, agent chips (stage plus exact model, mono), project and workflow selectors, Options, voice, Run with its shortcut (Ctrl or ⌘ + Enter).
- **Thread**: every state shares header → state strip → prompt bubble → stages → activity. The state strip carries the icon, the plain-language state and the relevant actions (Stop, Resume, View diff). The follow-up composer docks to the bottom.
- **Workflow Studio**: sections (Basics, Safety, Agents, Context, Generation) with a sticky navigator on desktop and accordions plus a chip bar on phones. Each agent is a card: role, provider, model, reasoning, context, permissions and enabled state on one scannable line. Full settings expand, with an Advanced disclosure for the long tail.
- **Command palette**: Ctrl or ⌘ + K, limited to supported navigation and existing actions. It never offers Goal completion, correction, attestation or mobile-restricted operations.
- **Phone**: drawer navigation, glance chips (needs you / running / failed) and attention lists above the docked composer, 44px targets, safe-area insets respected.

## Do's and Don'ts

Do: use tokens only; keep status colour to the three signals; show model ids in mono; keep the phone's first screen answering "what is it doing, does it need me, did it fail, can I tell it something".

Don't: add one-off CSS per screen, wrap a card in a card, use crimson for anything destructive, communicate state by colour alone, add a second elevation level, use the display face outside its allow-list, or let important text fall below 12px.
