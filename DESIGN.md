---
name: Turing Terminal
description: A light task-thread workspace for supervising coding agents from a desktop or a phone.
colors:
  canvas-blue: '#e0ebf8'
  rail-blue: '#d2e2f5'
  active-blue: '#bcd4ef'
  blue-wash: '#d3e5f9'
  paper-white: '#ffffff'
  ink: '#0a0e13'
  ink-secondary: '#28323e'
  ink-muted: '#4b5968'
  ink-faint: '#4d5b6b'
  link-blue: '#1456a8'
  link-blue-deep: '#0e4585'
  calm-red: '#c4504b'
  calm-red-deep: '#b0423e'
  red-wash: '#fbe6e4'
  crimson: '#9a1f24'
  go-green: '#1d6f46'
  green-wash: '#ddf1e5'
  approval-amber: '#7a5200'
  amber-wash: '#fbebc6'
  hairline: '#c9dbee'
  control-line: '#7a98b4'
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '28px'
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: '-0.02em'
  title:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '15px'
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 500
    lineHeight: 1.5
  control:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '13px'
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '12px'
    fontWeight: 600
    lineHeight: 1.4
  micro:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '11px'
    fontWeight: 600
    lineHeight: 1.4
rounded:
  row: '12px'
  panel: '14px'
  composer: '22px'
  button: '10px'
  pill: '999px'
spacing:
  xs: '6px'
  sm: '10px'
  md: '14px'
  lg: '20px'
components:
  button-primary:
    backgroundColor: '{colors.calm-red}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.button}'
    padding: '0 14px'
    height: '34px'
  button-primary-hover:
    backgroundColor: '{colors.calm-red-deep}'
  button-secondary:
    backgroundColor: '{colors.paper-white}'
    textColor: '{colors.ink}'
    rounded: '{rounded.button}'
    padding: '0 11px'
    height: '34px'
  composer:
    backgroundColor: '{colors.paper-white}'
    textColor: '{colors.ink}'
    rounded: '{rounded.composer}'
    padding: '14px 14px 10px 18px'
  pill-select:
    backgroundColor: '#eef4fb'
    textColor: '{colors.ink}'
    rounded: '{rounded.pill}'
    height: '34px'
  task-link-active:
    backgroundColor: '{colors.active-blue}'
    textColor: '{colors.ink}'
    rounded: '{rounded.row}'
    padding: '7px 10px'
---

# Design System: Turing Terminal

## Overview

**Creative North Star: "The Task Thread"**

Turing Terminal is a workspace where work is a conversation with a machine you own. One composer on a pale-blue field starts a task; every run becomes a thread you reopen from the left rail. It borrows the grammar people already know from the Claude Code and ChatGPT Codex apps (rail of tasks, centered composer, docked follow-up, drawer on a phone) and spends its own identity on honesty: what the desktop has confirmed is stated plainly, and what a provider does not report is labeled unavailable.

The surface is calm and flat. Light blue is the field, white is where work happens, text is black. Calm red appears only on the thing that moves work forward. Nothing glows, nothing is decorative, and nothing is smaller than 11px.

**Key Characteristics:**

- Light only. Pale-blue field and rail, white work surfaces, black text.
- Calm red is reserved for the primary action; failures and blocks use deeper crimson with an icon and a label.
- Thread-centered: composer first, runs as threads, a task list in the rail, a drawer on phones.
- System sans, 14px base, tabular figures; monospace only for code-like content.
- Near-flat depth: 1px blue-grey hairlines, one soft shadow on the composer.

## Colors

A pale-blue field with white work surfaces and one calm red voice.

### Primary

- **Canvas Blue** (#e0ebf8): the page field behind everything, and the top bar's translucent wash.
- **Rail Blue** (#d2e2f5): the left rail and the phone drawer, one step deeper than the field.
- **Active Blue** (#bcd4ef): the current nav item and the open task row, with a 1px #8fb4de border.
- **Link Blue** (#1456a8): links, text buttons, icons that mean "configure", the unread dot, selected states.

### Secondary

- **Calm Red** (#c4504b): the New task button, the send button, Start workflow, Approve once, Save actions. White text on it is 4.57:1. Hover is Calm Red Deep (#b0423e).

### Tertiary

- **Crimson** (#9a1f24): failed stages and error text, always with an icon or a label so it never reads as the call-to-action.
- **Go Green** (#1d6f46) on #ddf1e5: passed and online. **Approval Amber** (#7a5200) on #fbebc6: waiting for a decision.

### Neutral

- **Paper White** (#ffffff): composer, cards, stage rows, the current-task surface.
- **Ink** (#0a0e13): all primary text. **Ink Secondary** (#28323e), **Ink Muted** (#4b5968), **Ink Faint** (#4d5b6b, 4.5:1 or better on the rail).
- **Hairline** (#c9dbee): panel and divider lines. **Control Line** (#7a98b4): input and secondary-button borders (3:1 on white).

### Status colour

Colour on a status means exactly three things: **red** = failed or unavailable, **green** = completed or passed, **amber** = assistance required (waiting for approval or for you, paused). Running, queued, online, ready, connected, missing and everything else are neutral grey. The approvals dot and the bell dot are amber.

### Named Rules

**The Three Signals Rule.** Only red, green and amber carry status, and each always comes with an icon or a word. Routine states never get a colour.
**The One Red Rule.** Calm red marks the action that moves work forward and nothing else. If it is on a status, a badge or a decoration, it is wrong.
**The Failure Is Not a Button Rule.** Anything that failed or is blocked uses crimson with an icon and text, never calm red.

## Typography

**Display / Body / Label Font:** the system UI sans stack (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`). No webfont is loaded.

**Character:** familiar and quiet, so the work is the loudest thing on screen. Weight and size carry hierarchy, never a second typeface.

### Hierarchy

- **Headline** (650, 28px, 1.2, -0.02em): the home question "What should the agents do?" (22px on phones, balanced wrapping).
- **Title** (650, 15px): topbar title and run titles. Page h1s sit at 21px.
- **Body** (500, 14px, 1.5): composer text at 15px; prose capped near 65 to 75ch.
- **Control** (600, 13px): buttons, selects, row titles, list facts.
- **Label** (600, 12px): helper text, form labels, metadata.
- **Micro** (600, 11px): the floor, used for chips and status text only.

### Named Rules

**The 11px Floor Rule.** Nothing renders below 11px, and prose never below 12px.
**The Code-Only Mono Rule.** Monospace is for commands, paths, diffs and logs. Labels and numbers use the UI face with tabular figures.

## Layout

A fixed 280px rail (240px under 920px, a drawer under 680px) beside a fluid main column. Home is one centered column, 760px wide; an open thread is one 820px column; secondary pages use the full content width with two-column panel grids that collapse to one. On phones the composer docks to the bottom of the viewport, order is intro, blockers, status, tasks, composer, and primary controls are 44px. Spacing rhythm is 6, 10, 14, 20px, with more space above a heading than below it.

## Elevation & Depth

Hybrid but nearly flat: tonal layering (blue field, white surfaces) plus 1px hairlines. Shadows are rare and soft.

### Shadow Vocabulary

- **Composer lift** (`box-shadow: 0 1px 2px rgb(10 40 80 / 6%), 0 12px 32px rgb(10 40 80 / 8%)`): the composer and the docked follow-up box only. On focus a 3px blue ring is added.
- **Menu** (`0 8px 28px rgb(10 40 80 / 16%)`): popovers and the run actions menu.
- **Drawer** (`12px 0 32px rgb(10 40 80 / 18%)`): only while the phone drawer is open; the closed drawer is hidden.

### Named Rules

**The Flat-At-Rest Rule.** Surfaces are flat at rest. Only the composer, a menu and an open drawer lift.

## Shapes

Soft and consistent: composer 22px, panels 14px, task rows 12px, buttons 10px, pills fully round. Borders are 1px; there are no side-stripe accents, no clipped polygons, no decorative masks.

## Components

### Buttons

- **Shape:** 10px radius (pill for Start workflow; circle for send).
- **Primary:** Calm Red fill, white text, 34px high (44px on phones); disabled is #dce6f2 with #5c6c7e text.
- **Hover / Focus:** Calm Red Deep; focus is a 2px #0e4585 outline with 2px offset.
- **Secondary:** white fill, Control Line border, ink text. **Text button:** Link Blue, no fill.

### Icons

- **System:** one outline family (Lucide), 1.6px stroke, rounded caps, always `currentColor`. The same neutral (#3a4755) everywhere; icons differ by shape only.
- **Sizes by role:** 14px inline with 13px text (buttons, pills, text-button chevrons), 16px in navigation, rows and callouts, 18px for icon-only controls (menu, bell, voice, send).
- **No tiles:** icons stand on their own, never inside a tinted square or circle. Only status icons take colour (see Status colour).
- **Disclosure:** one chevron that rotates 90 degrees; no browser default triangles.

### Chips

- **Status pill:** wash fill with the matching deep text (green, amber, crimson, blue), 11 to 12px, always carries a word.

### Cards / Containers

- **Corner Style:** 14px. **Background:** white. **Border:** 1px Hairline. **Shadow:** none. **Padding:** 14 to 20px.

### Inputs / Fields

- **Style:** white or #eef4fb fill, 1px Control Line border, 8 to 10px radius.
- **Focus:** 2px Link Blue Deep outline; the composer shows a 3px blue ring on its container.
- **Disabled:** reduced contrast with a visible reason nearby (the composer states what is missing).

### Navigation

- **Rail:** wordmark, red New task button, task list (active first, status glyph plus title plus status and project), secondary nav, machine status. Active rows are Active Blue. On phones the rail is a drawer behind a scrim, opened from the top bar.

### Composer (signature)

A 22px white card holding the task text, project and workflow pills, an Options pill that reveals profile, permission mode and safety toggles, a voice button and a round red send button. After Review, the plan card appears above it and the send button becomes Edit request and Start workflow.

### Run thread

Back link, title and status, the prompt as a Blue Wash bubble aligned right, stage rows as separate white rows, and a docked follow-up box while the run is active.

## Do's and Don'ts

### Do:

- **Do** keep light blue as the field and white as the work surface; text is #0a0e13.
- **Do** use calm red (#c4504b) for the primary action only, and crimson with an icon for failures.
- **Do** keep every control at least 44px tall on phones and every text at least 11px.
- **Do** show provider limits as "Unavailable" with the reason, never a blank or a zero.
- **Do** put a new task, a thread or a status in the rail before inventing a new page.

### Don't:

- **Don't** colour an icon for decoration, or put one inside a tinted tile.
- **Don't** mix icon sizes or stroke weights; use the three size roles at 1.6px.
- **Don't** give routine states (running, online, ready, connected) a colour.

- **Don't** add a dark theme, glass, gradient text or decorative shadows.
- **Don't** use same-size icon cards or big-number tiles; prefer a definition list or a table of facts.
- **Don't** use monospace for labels or numbers.
- **Don't** put calm red on statuses, badges or decoration.
- **Don't** use a colored side border over 1px.

## Known drift and defects (not canonized)

- Workflow Studio's stage editor, Machines and the Settings rule forms were recoloured and re-spaced but not recomposed; they still follow the older form-and-panel pattern.
- Approval banners add a third accent (amber) and the bell's unread dot is still brown-red; both are tolerated, not endorsed.
- The Machines page, the run-preview plan card and populated stage output or diffs were not captured in review.
