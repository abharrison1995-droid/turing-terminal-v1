---
name: Turing Terminal
description: A calm, technical task workspace for supervising coding agents. Desktop is the IDE, the phone is the cockpit.
colors:
  canvas: '#dce8f4'
  nav: '#c9dcef'
  surface: '#f8fafc'
  surface-2: '#eef4fa'
  surface-3: '#e4edf7'
  selected: '#b9d0e8'
  ink: '#17202a'
  ink-2: '#3e4b5a'
  ink-3: '#4f5f72'
  control-line: '#6f8299'
  accent: '#d97757'
  accent-fill: '#b5532f'
  accent-fill-hover: '#a34726'
  accent-ink: '#a34726'
  accent-wash: '#fbece5'
  green: '#1e7a4d'
  green-wash: '#e3f1e8'
  amber: '#8a5a00'
  amber-wash: '#fbefd0'
  red: '#b42318'
  red-wash: '#fde8e6'
  info: '#2c5d8f'
typography:
  title:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '22px'
    fontWeight: 600
    lineHeight: '28px'
    letterSpacing: '-0.02em'
  section:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '15px'
    fontWeight: 600
    lineHeight: '20px'
  body:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: '20px'
  control:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '13px'
    fontWeight: 500
    lineHeight: '18px'
  meta:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '12px'
    fontWeight: 400
    lineHeight: '16px'
  mono:
    fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, Consolas, monospace"
    fontSize: '12px'
    fontWeight: 400
    lineHeight: '16px'
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
components:
  button-primary:
    backgroundColor: '{colors.accent-fill}'
    textColor: '#ffffff'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: '36px'
  button-primary-hover:
    backgroundColor: '{colors.accent-fill-hover}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '36px'
  composer:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.xl}'
    padding: '16px 16px 12px'
  chip-control:
    backgroundColor: '{colors.surface-2}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '36px'
  nav-active:
    backgroundColor: '{colors.selected}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '36px'
---

# Design System: Turing Terminal

The single source of truth in code is `src/client/styles/tokens.css`. This document describes the intent behind it.

## Overview

**North star: The Task Thread.** One workspace in which a task is a thread: you describe it, agents work on it, you answer when they need you. Desktop is the IDE (orchestration, configuration, inspection). The phone is the cockpit (start, watch, approve, intervene), reached through the same components in a different arrangement, not a shrunken desktop.

Character: Codex-level restraint, Claude-like warmth, a deep pale-blue field. Calm, technical, dense where useful, never a dashboard.

Hierarchy: application canvas → navigation → workspace → object → control. Typography, spacing and tonal change come before borders. A card is an object, not a layout primitive.

## Colors

- **Canvas / nav (`#dce8f4` / `#c9dcef`)**: the pale-blue field. Navigation is one step deeper than the canvas.
- **Surface / surface-2 / surface-3**: raised work surface, its quieter sibling for chips and nested groups, and a pressed or selected-soft tone.
- **Selected (`#b9d0e8`)**: the one blue tonal selection state (nav, active thread).
- **Ink / ink-2 / ink-3**: three text levels. All pass 4.5:1 on canvas and nav. There is no lighter text; placeholders use ink-3.
- **Accent (warm orange)**: `accent-fill` carries primary actions and the switch-on state (white text, 4.9:1); `accent` is for small identity marks only (brand mark, bar fill); `accent-ink` is for text actions. Orange is never a status colour and never used for destructive actions.
- **Status**: red = failed, green = completed, amber = assistance required, `info` = running (with a pulsing dot). Everything else is neutral. State is always also stated in words or by icon shape.

### Named rules

- **The Orange Budget.** At most one orange fill per view region: the Run button, Approve once, Resume run, Save. If two orange fills compete, one is wrong.
- **The Three Signals Rule.** Colour marks failure, completion and a request for the user. Informational notes stay neutral.
- **Borders Are Last.** Prefer a tone step, then spacing, then a hairline. Inputs keep a 3:1 border because they must be findable.

## Typography

Geist Sans for UI, Geist Mono for commands, branches, model and provider ids, hashes, logs and code. Both are bundled (`@fontsource-variable`), so the app works offline in the PWA and the Tauri shell. Tabular numerals are on globally for elapsed time, tokens, costs and counts.

Scale: title 22/28, section 15/20, body 14/20, control 13/18 (medium), meta 12/16, micro 11 (badges and counters only). Weights: 400 body, 500 controls, 600 headings. The composer input and phone form fields use 16px (prevents mobile zoom).

## Layout and spacing

4px/8px rhythm (`--s-1` to `--s-12`). Desktop page width 1280, padding 32. Home column 760. Thread column 820. Controls are 36px (28 compact, 40 large); every control on a phone is 44px.

## Elevation

One level only (`--elev-float`) for floating UI: menus, toasts, the phone drawer, the docked phone composer, the sticky follow-up bar. Cards, panels and the desktop composer are flat.

## Shapes

Radii: 6 (chips, kbd), 8 (controls, rows), 12 (panels), 16 (composer, bubbles), pill (counts, glance chips, status pills).

## Components

- **Buttons**: primary (orange), secondary (surface), quiet, danger (red wash), text (accent-ink), icon (36px, 18px glyph). States: hover, pressed, focus-visible (2px orange ring, 2px offset), disabled, `aria-busy`.
- **Fields**: 36px, 1px `control-line`, focus ring in accent. Toggles are switches (orange when on); checkboxes use accent colour.
- **Status pill**: tonal fill, no border, 12px medium. Running shows a pulsing dot.
- **Rows**: one interactive-row recipe for runs, projects and templates; hairline separators only inside lists and tables.
- **Disclosure**: one chevron, one summary pattern (`settings-disclosure`), used for advanced settings everywhere.
- **Notices**: neutral by default; amber and red tints only for assistance and failure.
- **Composer (signature)**: the largest object on Home. Textarea, agent chips (stage + exact model, mono), project and workflow selectors, Options, voice, Run with its shortcut (Ctrl or ⌘ + Enter).
- **Thread**: every state shares header → state strip → prompt bubble → stages → activity. The state strip carries icon, plain-language state and the relevant actions (Stop, Resume, View diff). The follow-up composer docks to the bottom.
- **Workflow Studio**: sections (Basics, Safety, Agents, Context, Generation) with a sticky navigator on desktop and accordions plus a chip bar on phones. Each agent is a card: role, provider, model, reasoning, context, permissions and enabled state on one scannable line; full settings expand, with an Advanced disclosure for the long tail.
- **Phone**: drawer navigation, glance chips (needs you / running / failed) and attention lists above the docked composer, 44px targets, safe-area insets respected.

## Do's and Don'ts

Do: use tokens only; keep status colour to the three signals; show model ids in mono; keep the phone's first screen answering "what is it doing, does it need me, did it fail, can I tell it something".

Don't: add one-off CSS per screen, wrap a card in a card, use orange for anything destructive, communicate state by colour alone, add a second elevation level, or let important text fall below 12px.

## Known drift and defects (not canonized)

- Settings rule forms and Machines profile forms use the new primitives but keep their original form-and-panel composition.
- Diff output is monochrome; a line-level diff view is not designed yet.
- Workflow Studio has no workflow-level output settings, so the brief's "Output" group is represented by output-type stages (commit, push, notification) inside Agents.
