# UI.0 — Design-packet reconciliation and implementation specification

Status: **DRAFT for independent review. No production code changed.**
Audited source: `c775a6b` (tip of `feature/grand-project-goal-engine`, PR #3 still open, Goal Engine hardening in progress).
Packet: `Turing-Terminal-UI-Package.zip` (README, 9-page PDF, `asset-manifest.json`, 10 PNGs). Original README and manifest are copied to `docs/ui/packet-reference/`. The PNGs are not committed here (18 MB); they must be added in UI.1 under an explicit decision (see D-9).

Authority order: (0) the `AGENTS.md` architectural invariants (billing evaluator, no unrestricted shell, Goal and mobile authority) outrank everything below; (1) the packet, (2) the owner's brief, (3) existing `DESIGN.md` — which **conflicts with the packet** and will be superseded (see §6).

---

## 1. Packet inventory

| #   | File                                                      | Role in packet                                | Status                            |
| --- | --------------------------------------------------------- | --------------------------------------------- | --------------------------------- |
| P1  | `ui/overview-dashboard.png` 1586×992 RGB                  | Preferred app shell + Overview                | Current                           |
| P2  | `ui/new-task-provider-routing.png`                        | Composer + provider/model/effort routing      | Current                           |
| P3  | `ui/workbench-agent-run.png`                              | Editor + run timeline + Goal panel + terminal | Current                           |
| P4  | `ui/goal-engine-cockpit-refined.png`                      | Goal Engine cockpit                           | Current                           |
| P4h | `ui/goal-engine-cockpit-first-pass.png`                   | History                                       | Not to implement                  |
| P5  | `mascot/skull-status-atlas-simplified.png` 1536×1024 RGBA | Preferred mascot; 4 rows × 6 frames           | Current, **not production-ready** |
| P5h | `mascot/skull-status-atlas-detailed-exploration.png`      | History                                       | Not to implement                  |
| P6  | `mascot/skull-directional-wipes-six-visible-poses.png`    | Preferred wipes; 6 directions × 6 poses       | Current, **not production-ready** |
| P6h | `mascot/skull-directional-wipes-early.png`                | History                                       | Not to implement                  |
| P7  | `mood/black-metal-forest-atmosphere.png`                  | Mood only; "not a literal page background"    | Reference only                    |
| —   | README + PDF                                              | Direction, cautions                           | Governing text                    |

Not supplied: the user's "design reference image" and the blackletter font file (README: "not bundled"); Linux Libertine is cited by URL only. **No mobile mockup, no settings/pairing/machines/usage/runs/workflow-studio mockup, no empty/loading/error/disconnected/disputed-state designs, no contrast or token values, no breakpoints.** The brief's request to "include additional breakpoints from the packet" cannot be met: the packet defines none (the README says only "adapt the layout for narrow screens").

### Measured asset facts (not assumed)

- Both mascot atlases have an alpha channel but **0 % of pixels are fully opaque** (max alpha 254) and 62 % / 71 % are fully transparent. The skull body is effectively opaque (alpha ≥ 250 for ≈30 % / ≈19 % of pixels), so restoring it is trivial; the real hazard is the large baked haze, including a red background glow across status rows 3–4 that would break accent scarcity. Cells cannot be sliced as-is: they need re-registration, haze removal and a verified frame map.
- The status atlas covers **only four rows**: idle (6 near-identical frames), thinking (red pip orbiting), loading (red pip ring), phase-progress (arc fills, final frame adds a white "+" badge). There are **no planning / implementing / reviewing / success / failure / disappearance art states.** The wipe sheet provides the disappear/transition only. The brief's list of states exceeds the supplied art (see D-4).
- The wipe sheet's last column is a small (≈6–12 px) remnant; README says hide immediately after pose 6.
- Row 1 of the wipe sheet (L→R) and row 2 (R→L) show a clipped skull; rows 5/6 are center-out. Row/direction mapping follows README order and must be re-verified when sliced.

## 2. Screens, components and states traceability

Legend: **Reuse** / **Reskin** / **Refactor** / **Replace** / **Build new**. "Current" = repository equivalent at `c775a6b`.

### 2.1 Screens

| Packet screen          | Current equivalent                                                                                                 | Class                  | Notes                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Overview            | `CommandCenter` (`App.tsx:811`, page `'command'`, labelled Home) + `home.css`                                      | Refactor               | Packet's Overview is dashboard-shaped (active work, usage snapshot, routing, recent workspaces, safeguards). Current Home is a task composer. DESIGN.md "never a dashboard" is overturned by the packet. |
| P2 New Task            | `CommandCenter` composer + `RunPreviewPanel` (`:1407`) + `phase36.tsx` model pickers                               | Refactor               | Split composer from Home into its own route; reuse run preview and billing evaluation unchanged.                                                                                                         |
| P3 Workbench           | **None.** Nearest: `RunDetail` (`:4141`), `RunStageRow`, diff view in run detail                                   | **Build new**          | Packet depicts a code editor with tabs, file tree, terminal, "Review changes". **No editor, terminal or file-tree exists in the client** (no CodeMirror/Monaco/xterm in `package.json`). See §3-A1.      |
| P4 Goal cockpit        | `goals/GoalCockpit.tsx`, `GoalsPage`, `GoalOverview`, `GoalMobileCockpit`                                          | Reskin + Refactor      | Packet is a deliberately sparse summary; actual cockpit carries far more authority-bearing state (§2.3). Packet cannot replace it; it informs the header/summary layer only.                             |
| Workflow Studio        | `WorkflowsPage` (`:1705`), `studio.css`                                                                            | Reskin                 | Nav item exists in packet; no screen designed.                                                                                                                                                           |
| Projects               | `ProjectsPage` (`:3755`)                                                                                           | Reskin                 | No design. Packet's left rail shows a workspace file tree (see Workbench).                                                                                                                               |
| Runs / Run detail      | `RunsPage` (`:4018`), `RunDetail`, `RunStageRow`                                                                   | Reskin                 | No design.                                                                                                                                                                                               |
| Reviews                | **None as a page** (approvals exist: `goals/UnifiedApprovals.tsx`; run approvals in RunDetail)                     | **Build new** or alias | P1 nav has "Reviews"; P4's nav differs ("Grand Projects", no "Reviews"). See A-6.                                                                                                                        |
| Usage                  | `UsagePage` (`:4841`)                                                                                              | Reskin                 | Packet shows only a small "Usage snapshot" tile (example data).                                                                                                                                          |
| Machines               | `MachinesPage` (`:5187`)                                                                                           | Reskin                 | No design.                                                                                                                                                                                               |
| Settings               | `SettingsPage` (`:5382`) incl. `DesktopSettingsCard`, `TailscaleReadinessCard`, `PairingSettings`, `RulesSettings` | Reskin                 | No design. P1/P2 show a Safeguards strip that overlaps Settings (A-3).                                                                                                                                   |
| Device pairing (phone) | `DevicePairingPage` (`:660`)                                                                                       | Reskin                 | No design.                                                                                                                                                                                               |
| Mobile (all)           | Responsive CSS in `mobile.css` (1180/920/760/680 px), `goals.css` (1024/640), `useCompactViewport` (640)           | Refactor               | **No packet design.** README: "adapt for narrow screens".                                                                                                                                                |
| Global search ⌘K       | **None** (search box/“Search or run a command” in P1–P3)                                                           | Build new              | A command palette is implied but unspecified. See A-5.                                                                                                                                                   |
| Title bar              | Native OS window (`tauri.conf.json`, no `decorations:false`)                                                       | Decision               | Packet draws macOS traffic lights + breadcrumb + account menu. See A-4.                                                                                                                                  |
| Account menu "N ▾"     | **None** (single-user local app)                                                                                   | Do not build           | No account model exists; would be fabricated.                                                                                                                                                            |

### 2.2 Components (visual and interactive)

| Component (packet)                                           | Current                                       | Class                     | Dependency / note                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand lockup, blackletter wordmark                           | `brand-lockup` / `turing.svg`                 | Replace                   | Needs the blackletter font file (not supplied; A-2).                                                                                                                                              |
| Sidebar nav (9 items in both P1 and P4, red active bar)      | `aside.sidebar` `task-nav` `primary-nav`      | Reskin                    | Page enum `Page` has 8 values; packet adds New Task, Reviews, (Grand Projects). Map in §4.                                                                                                        |
| Workspace/file tree in sidebar                               | none                                          | Build new                 | Needs a read-only file listing API; none verified. Out of scope unless approved (A-1).                                                                                                            |
| Search + ⌘K palette                                          | none                                          | Build new                 | A-5.                                                                                                                                                                                              |
| Breadcrumb / project & branch pickers                        | partial (project select in composer)          | Refactor                  |                                                                                                                                                                                                   |
| Cards, active-work card with red border                      | `.card`/`primitives.css`                      | Reskin                    | "Red border" = status emphasis; must follow scarcity rule.                                                                                                                                        |
| Stepper (Plan→Impl→Review)                                   | stage rows, goal milestone UI                 | Refactor                  | Data = real stage/run status, never decorative.                                                                                                                                                   |
| Provider/Model/Effort selects with status dot                | `phase36.tsx` pickers, `StudioSection`        | Reskin + Refactor         | Dot colour must derive from real provider/auth/catalog "last known" state.                                                                                                                        |
| Role cards Planner/Implementer/Reviewer                      | Workflow stage editor (`WorkflowStageEditor`) | Refactor                  | Packet's fixed three roles are a simplification; real workflows have arbitrary stages. Must not constrain model.                                                                                  |
| Safeguards (approval, paid fallback, OpenRouter, max agents) | Settings + run profile fields                 | Refactor                  | Billing protections must keep their current single evaluator (`evaluateBillingLane`). Toggle for "Automatic paid fallback" must not become able to enable silent PAYG (A-3).                      |
| Usage snapshot bar chart ("Example data")                    | `UsagePage` (provenance-aware)                | Refactor                  | Provenance labels (provider-reported/observed/estimated/unavailable) must survive.                                                                                                                |
| Recent workspaces table                                      | `ProjectsPage` list                           | Refactor                  |                                                                                                                                                                                                   |
| Prompt composer, Ctrl+Enter, Save draft                      | `CommandCenter` composer                      | Refactor                  | "Save draft" has **no backend** (verified: no `Save draft`/`saveDraft` anywhere in client or server; workflow/refinement drafts are unrelated); defer, since server work is out of UI scope (§8). |
| Attach context                                               | context management (docs/CONTEXT_MANAGEMENT)  | Refactor                  | Verify capability before exposing.                                                                                                                                                                |
| Code editor w/ diff gutter, tabs                             | none                                          | Build new                 | A-1.                                                                                                                                                                                              |
| Terminal panel (live shell)                                  | none                                          | **Do not build as drawn** | AGENTS invariant: "No unrestricted model-generated shell". A user terminal is a new authority surface. A-1.                                                                                       |
| "Review changes" / Open review (PR link)                     | PR/diff UI in run detail; Goal handoff        | Refactor                  | "Open PR #3" must be a real external link built from real data.                                                                                                                                   |
| Toggle switch, dropdown, buttons, kbd chips                  | `primitives.css`                              | Reskin                    | New dark tokens.                                                                                                                                                                                  |
| Toasts, dialogs, status pills                                | existing `notice`, modal patterns             | Reskin                    | Inventory exact set in UI.1.                                                                                                                                                                      |
| Mascot (status loops, wipes)                                 | none                                          | Build new                 | §5, A-4/D-4.                                                                                                                                                                                      |

### 2.3 Goal Engine — what the packet does and does not cover

The refined cockpit (P4) shows: stage stepper, checkpoint id with copy, "Independent review pending", "Open PR #3", "Execution state / Executor disabled", "Review plan", a checkpoint-pushed notice. It **does not** depict (and cannot be treated as authorising removal or simplification of): contracts/milestones, supervisor progress, findings, interventions, approval gates, manual integration handoff, external attestation, completion decision, correction/withdrawal/supersession, completion-standing qualifiers, unknown-outcome recovery, terminal/historical states. Current code for these lives in `src/client/goals/*` (55 files, ≈24 k lines incl. tests, with `completionStandingCopy`, `correctionModel`, `completionModel` as the authority-relevant presentation logic).

**Rule for UI.3:** migrate styling and layout only. Any pixel in P4 that implies a state ("2 minutes ago", "Executor disabled", "7C.2B.5B", "Open PR #3") is illustrative; the cockpit continues to render solely from `goalApi` data and existing models. The primary "Open PR" button style is presentation of an existing external link, never a new authority control.

### 2.4 State coverage required but not designed

Empty, loading, error, pending, success, disputed (completion standing contested/unverifiable), disconnected/offline, revoked-device, provider-outage, unsupported-model, unknown-outcome. Packet supplies none. UI.1 must derive them from the token/status system and existing copy; each needs an owner-visible sample in the visual-review route (§8). This is a _missing-design_ item, not licence to invent screens.

## 3. Ambiguities that materially change behaviour (owner decisions)

| ID  | Question                                                                                                                                                                                                                                                                  | Recommendation                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-1 | **Workbench (P3) requires a code editor, file tree and live terminal. None exist.** A terminal is a new authority surface that conflicts with AGENTS.md ("no unrestricted shell… execution broker"). Is the Workbench in scope for V1 (which is entering feature freeze)? | Do **not** build editor/terminal in this programme. Implement Workbench as a _read-only_ Run workspace (run timeline, stage output, diff/changes, Goal context) using the P3 layout; defer editor+terminal as an owner-approved deferred item (brief UI.8 permits this). |
| A-2 | Blackletter display font and Linux Libertine files are **not bundled**; licences unverified. Libertine is under GPL+font-exception/OFL variants; blackletter face is unnamed.                                                                                             | Owner to name the blackletter font and supply files. Until then use a documented fallback stack and ship nothing unlicensed. (Candidate OFL faces e.g. UnifrakturCook/Pirata One are suggestions only, not packet decisions.)                                            |
| A-3 | P1/P2 "Safeguards": "Automatic paid fallback" toggle, "Optional OpenRouter" toggle, "Max agents", "Approval before edits". Where is each stored, and can the UI offer an "On" for paid fallback?                                                                          | UI binds to the existing fields and billing evaluator; where a safeguard has no real backing field, show it read-only or omit it. No new billing authority.                                                                                                              |
| A-4 | Custom window chrome (traffic lights) vs. native decorations; mascot placement/state map beyond the 4 supplied rows.                                                                                                                                                      | Keep native decorations (Tauri `decorations` unchanged, Linux/Windows targets only). Mascot states: see D-4.                                                                                                                                                             |
| A-5 | ⌘K command palette scope.                                                                                                                                                                                                                                                 | Minimal navigation + "go to project/run/goal" palette, no actions with side effects. Needs owner OK; otherwise omit the input and keep the sidebar filter only.                                                                                                          |
| A-6 | Nav set: P1 (Home, New Task, Workflow Studio, Projects, Runs, Reviews, Usage, Machines, Settings) vs P4 (…"Grand Projects", no Reviews). Current: command, workflows, projects, goals, runs, usage, machines, settings.                                                   | Union: Home, New Task, Workflow Studio, Projects, **Goals** (label "Grand Projects" per P4), Runs, Reviews (unified approvals), Usage, Machines, Settings. Reviews = existing `UnifiedApprovals` + run approvals; no new authority.                                      |
| A-7 | "Save draft", "Attach context", "Effort" selects, account menu, "Local workspace" breadcrumb: backed by real data?                                                                                                                                                        | Include only when backed (verified per item in UI.1 RED tests); else record as deferred.                                                                                                                                                                                 |
| A-8 | Theme: packet is dark-only. Current app is **light-only** (documented in `V1_READINESS` and enforced by a test that forbids `prefers-color-scheme`/`data-theme` in goal CSS).                                                                                             | Dark-only (packet governs). Update `a11yTokens.test.ts` to compute contrast from the new tokens and keep its no-theme-switch rule; this is a rewrite of premise, not a weakening. Light theme dropped; document in V1_READINESS.                                         |
| A-9 | Mobile design is absent. The brief requires first-class iPhone UI. DESIGN.md says "phone is the cockpit" with the same components.                                                                                                                                        | Derive mobile from the dark tokens + existing mobile structure; produce owner-reviewed mobile mockups (generated by this programme, labelled derived) at UI.5 start. Not claimed as packet-specified.                                                                    |

## 4. Navigation and journey map (current → target)

Current pages (`Page` union, `App.tsx:116`): `command, workflows, projects, goals, runs, usage, machines, settings`, plus unpaired `DevicePairingPage` and a task-thread nav (`task-nav`).

Target IA (pending A-6): Home(Overview) → New Task → Workflow Studio → Projects → Goals → Runs → Reviews → Usage → Machines → Settings. `App.tsx` is a single 6 571-line file; the IA change must be preceded by **extraction** (§6) so the migration is reviewable.

Journeys to preserve (each gets a regression walkthrough in UI.7): first launch; pairing (QR + code, desktop approval, revoke); project select; prompt→model route→run preview→start; workflow create/edit; run monitor/approve/intervene/stop; prompt refinement confirm; goal create→definition→proposal→run→review→handoff→attestation→completion→correction/withdrawal; provider outage/unsupported model; offline/reconnect; revoked device.

## 5. Mascot and motion specification

- Source of truth: P5 (status) and P6 (wipes). Slicing is **a prerequisite task (M-0)**: detect cell grid, per-cell crop, normalise registration to a common anchor, clean alpha (remove haze below a threshold, restore the skull body to opaque), export as separate PNG frames or a verified sprite sheet with a JSON frame map and a checked hash. A test must assert frame count (24 status + 36 wipe), dimensions, no fully-transparent frame (except none expected), and consistent bounding-box anchor.
- Visual regeneration is **not** permitted to "fix" the art (brief: use supplied artwork). If cleanup is insufficient, escalate to owner.
- State map from supplied art only: idle→row 1 (static or very slow), thinking→row 2, loading→row 3, phase-progress→row 4 (maps to Planning/Implementing/Reviewing as _progress through real phases_, not invented art), transition/disappear→wipes. **Success, failure, error: no art supplied** → use existing status icons + text, not the mascot (D-4). Mascot is never the sole carrier of an error, warning or approval.
- Component: `<Mascot state=… />` pure presentation; state is a prop derived from real run/goal state in a separate selector (README: "keep the visual asset separate from motion logic").
- Deterministic sequencing: CSS `steps()` or a single `requestAnimationFrame`/timer-driven frame index with injected clock for tests; loops only while the work is active; wipes are single-pass then unmounted. `prefers-reduced-motion: reduce` → static first frame, no wipe (instant swap). No flashing; no continuous red pulsing; layout slot fixed-size to avoid layout shift.

## 6. Design-token specification (initial; values to be fixed in UI.1 with measured contrast)

Packet gives no hex values. Tokens below are _derived from the mockups by sampling_ in UI.1 (not guessed), then contrast-validated. Names replace the current light tokens in `src/client/styles/tokens.css` (single source of truth, retained); the existing semantic names (`--canvas`, `--surface`, `--ink`, `--accent-fill`, `--green/amber/red`, `--s-*`, `--r-*`) are kept so the ≈1 670 existing `var(--…)` references continue to resolve; values change, names do not, except additions.

| Group      | Tokens                                                                                                                         | Source / rule                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces   | canvas (black→charcoal gradient), nav, surface, surface-2, surface-3, selected, scrim                                          | Sampled from P1; near-black panels with quiet borders.                                                                                                                             |
| Text       | ink, ink-2, ink-3, ink-disabled (all ≥ 4.5:1 on surfaces; disabled documented)                                                 | P1/P2: off-white, stone grey.                                                                                                                                                      |
| Accent     | crimson `accent`, `accent-fill`(+hover/pressed), `accent-ink`, `accent-wash`, focus ring                                       | **Scarcity rule** (README): active nav, primary action, genuine progress, important status only.                                                                                   |
| Status     | green (done/online), amber (needs attention), red _distinct from accent_ (failure), info                                       | P1 uses green dots and an amber warning; red-as-accent vs red-as-failure must be separable by shape+text (WCAG 1.4.1).                                                             |
| Mascot     | ash/stone/off-white; no orange                                                                                                 | README.                                                                                                                                                                            |
| Type       | `--font-display` (blackletter; brand + large titles only), `--font-sans` → Linux Libertine for UI text, `--font-mono` for code | README. **Replaces Geist.** Libertine is a serif at small sizes: re-verify size scale (14 px body minimum, 12 px meta floor). Display face forbidden in nav, labels, tables, code. |
| Scale      | Keep current `--fs-*`/`--lh-*` pending Libertine metrics review; add `--fs-display-*`                                          | Keep.                                                                                                                                                                              |
| Space/size | Keep `--s-*`, `--h-control`, `--h-touch: 44px`; sidebar width from P1 (≈300 px at 1586) → tokenised                            | Keep rhythm.                                                                                                                                                                       |
| Radius     | Keep; packet cards ≈6-8 px                                                                                                     |                                                                                                                                                                                    |
| Elevation  | Single float level kept; add inner-border convention for dark panels                                                           |                                                                                                                                                                                    |
| Motion     | Keep `--dur*`; add mascot frame durations; global reduced-motion rule                                                          | Currently only 1 `prefers-reduced-motion` rule exists in the CSS — gap.                                                                                                            |
| Meta       | `theme-color` / PWA `background_color` change from `#dce8f4` (`index.html:6`, `vite.config.ts:15-16`)                          | Missed-by-default regression point.                                                                                                                                                |

Current CSS hygiene: ≈34 colour literals in `tokens.css` only; **5 stray hex literals** (`goals.css` ×4, `phase36.css` ×1) must be tokenised. Fonts: Geist is bundled via `@fontsource-variable` (offline PWA/Tauri; CSP `font-src 'self' data:`), so new fonts must be bundled locally; no CDN fonts.

## 7. Reusable component architecture

Ownership principle: one primitive layer, one shell layer, feature layers consuming them. Targets (new directory `src/client/ui/`, all with tests):

1. `tokens.css` (exists) — only place with literals.
2. `ui/primitives`: Button, IconButton, Select/Menu, Toggle, TextField/Textarea (composer), Tabs, Card, Panel, Dialog, Toast, StatusPill/Dot, Kbd, Stepper, EmptyState, ErrorState, Skeleton/Loading, Tooltip. Derived from `primitives.css` classes; do not fork per feature.
3. `ui/shell`: AppShell (sidebar, topbar, breadcrumb, rails), ResponsiveFrame (desktop rails ↔ mobile bottom-nav/drawer), ConnectionBanner (offline/reconnecting/revoked).
4. `ui/mascot`: `Mascot`, `useMascotFrames`, frame map, reduced-motion handling.
5. `ui/workflow-routing`: ProviderSelect/ModelSelect/EffortSelect/RoleCard — **presentation only**; data from existing catalog and billing evaluators.
6. Feature modules extracted from `App.tsx` into `src/client/pages/*` (Overview, NewTask, WorkflowStudio, Projects, Runs/RunDetail, Reviews, Usage, Machines, Settings, DevicePairing). Extraction is behaviour-neutral and precedes reskin (§8 stage UI.1a).
7. `goals/*` stays as is structurally; reskinned via tokens/primitives; models (`completionStandingCopy`, `correctionModel`, `completionModel`, `controls.ts`) **untouched**.

Mobile: `useCompactViewport` (≤ 640 px) is presentation only and documented as such; keep. Server remains sole authority gate (`goalMobile.test`, `mobileStanding.test` as the safety net).

## 8. Implementation dependency graph and phased plan

```
UI.0 spec ──► [gate G0: independent review + owner decisions D-1..D-9 + accepted Goal Engine base]
                │
                ├─► M-0 mascot asset prep (independent; needs only packet) ───────────────────────┐
                ▼                                                                                   │
UI.1a extract App.tsx → pages/*  (no visual change; tests stay green)                               │
UI.1b tokens (dark) + fonts + primitives + a11yTokens test rewrite + PWA meta                        │
UI.1c AppShell, nav (A-6), responsive frame, loading/error/empty states                             │
                ├─► UI.2 Agent workbench: Overview, New Task, routing, run preview, run detail ◄────┤
                ├─► UI.3 Goal cockpit migration (after UI.1c; Goal Engine base frozen)              │
                ├─► UI.4 Settings/pairing/machines/usage (after UI.1b/c; reconcile pairing fix)     │
                ▼                                                                                   │
UI.5 mobile PWA (after 2,3,4) ──► UI.6 mascot integration (needs M-0) ◄─────────────────────────────┘
                ▼
UI.7 qualification (screenshots/walkthroughs) ──► UI.8 final independent reviews
```

Stage parallelism: UI.2/3/4 may run in separate worktrees only if they touch disjoint modules after UI.1a; shared CSS changes funnel through UI.1b.

Per-stage governance as in the brief (base SHA → scope+matrix → RED tests → implement → focused+full gates → fresh Sonnet 5.5 review → fix → fast-forward push → exact-SHA CI → evidence in `docs/ui/EVIDENCE.md`).

### Acceptance criteria (summary; each stage expands to a matrix)

- **Global**: `format:check`, `lint`, `typecheck`, `npm test`, `build`, `audit --omit=dev` green; hosted CI < 30 min (current `timeout-minutes: 30`; **do not raise**; if new tests risk it, measure first); no server/schema/migration diff in any UI stage (enforced by diff check in review). Features needing server work (run drafts, workspace file listing) are not UI work: they need a separate owner-approved non-UI stage with its own review, otherwise they are deferred.
- **Tokens**: zero colour literals (hex, `rgb()`/`rgba()`, `hsl()`, named, SVG fills, mascot assets) outside `tokens.css` (currently 5 hex + 3 rgb literals outside, 44 colour lines inside); contrast test computes ≥ 4.5:1 for text pairs, ≥ 3:1 for UI components/focus on the _new_ tokens; accent never the only carrier of status.
- **Typography**: display face used only on allow-listed selectors (brand, page `h1`); a test greps CSS to enforce.
- **Shell**: every nav item reaches its page; keyboard: tab order, visible focus, `Esc` closes menus/dialogs, focus returns to invoker; landmarks preserved (`aside[aria-label]`, `nav`).
- **Workbench/New Task**: provider/model/effort controls show only catalog-sourced options; unsupported model and provider outage render the existing "last known" states; no static mock values (tests assert values come from fixtures via API, and fail on literal "Kimi K3", "7C.2B.5B" etc. in source).
- **Billing**: existing billing-lane tests pass unmodified; a new test proves the paid-fallback control cannot enable a metered path in Subscriptions-Only.
- **Goal**: existing goals test files pass unmodified (they are the behavioural spec); a contested/unverifiable completion never renders unqualified; read-only displays gain no controls (assert via role/button query diff).
- **Mobile**: compact viewport shows desktop-only notice for completion/correction/attestation and issues no such request (existing tests + new ones at 390 and 375 widths); touch targets ≥ 44 px.
- **Motion**: reduced-motion test (matchMedia mock) → no running animations; frame sequence unit tests with fake timers; mascot never rendered inside alert/approval regions.
- **Visual (UI.7)**: Playwright (or equivalent headless Chromium; not currently a dependency — adding one needs owner OK, D-8) screenshots at 1920×1080, 1440×900, 1280×800, 1024×768, 390×844, 375×812, stored under `docs/ui/evidence/`, each paired with its packet mockup and a written discrepancy list. No "pixel-perfect" claims. Physical iPhone/native checks labelled _not performed_ unless done.

## 9. Risks and regression points

1. **`App.tsx` monolith (6 571 lines) + `phase36.tsx` (2 123)**: any reskin inside it is high-conflict with Goal Engine fixes landing on the same base. Mitigate: wait for accepted base; extraction first, mechanical.
2. **Test premise**: `a11yTokens.test.ts` encodes the light theme and "no theme switch"; ~15 goal tests (e.g. `goalMobile`, `mobileStanding`) assert text/roles that a reskin must not change. Re-run them unmodified as the gate.
3. **Authority leakage**: packet's generic "Open review/Approve" buttons vs. mobile restrictions and completion/attestation authority. Mitigation: no new buttons on goal surfaces; compare role-query snapshots before/after.
4. **Fabricated data**: P1–P3 are dense with illustrative values. Mitigation: source-grep tests for sample strings.
5. **Font/licence**: unsupplied display font; Libertine small-size legibility on dark; possible bundle-size and PWA precache growth.
6. **Dark theme side effects**: `color-scheme`, scrollbars, native form controls, diff colours (red/green on dark), PWA splash/theme colour, Tauri webview background flash (`visible:false` already helps).
7. **Mascot assets** not production-ready (measured above); animation CPU/battery on mobile; layout shift.
8. **CI budget**: screenshot tooling and more tests vs. 30-minute limit.
9. **Pairing**: reconcile the separate bodyless-JSON fix; do not branch UI.4 until it is merged to the accepted base.
10. **Sidebar tree/terminal/editor scope creep** (A-1).
11. **Reduced-motion/accessibility regressions** from mascot and red-heavy palette (colour-only status).
12. Mobile has no design: risk of drift from desktop; mitigated by derived-mockup owner review.

## 10. Recommended Git base and integration strategy

- **There is no accepted base yet.** Master (`2ae9dfc`, RC2) predates the Goal Engine; PR #3 (`feature/grand-project-goal-engine`, 211 commits ahead) is open and still receiving HR-Q4 hardening commits (tip `c775a6b` as of this audit). Per brief, UI implementation must not start against it.
- Recommended: wait for the Goal Engine owner to declare an **accepted checkpoint SHA** (ideally the merge commit on `master`, otherwise a tagged tip of the feature branch with green exact-SHA CI). Create `ui/overhaul` from that SHA in a **separate worktree** (`/home/alex/Desktop/tt-worktrees/ui-overhaul`), never in the Goal Engine worktree or the other `tt-worktrees/*`.
- Stage branches `ui/uiN-*` fast-forward into `ui/overhaul`; rebase (not merge) onto any later accepted Goal Engine commits, re-running the full gate; the final PR targets `master` and is **not merged without explicit owner instruction**.
- This audit worktree: `/home/alex/Desktop/tt-worktrees/ui0`, branch `ui/ui0-audit` at `c775a6b`, docs-only; contents rebase trivially onto the accepted base.
- Until the base is accepted, only **M-0 (mascot asset prep)** and font acquisition/licence work can proceed, because they touch no shared source.

## 11. Open owner decisions

| ID  | Decision                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- |
| D-1 | Accepted Goal Engine base SHA (or merge) — blocks UI.1+.                                        |
| D-2 | Workbench scope: read-only Run workspace now; editor/terminal deferred (A-1).                   |
| D-3 | Name/supply blackletter font; confirm Libertine file/licence (A-2).                             |
| D-4 | Mascot states limited to supplied art; success/failure via icons/text (§5).                     |
| D-5 | Nav union and "Grand Projects" label (A-6).                                                     |
| D-6 | ⌘K palette: include minimal, or omit (A-5).                                                     |
| D-7 | Dark-only; drop light theme; update readiness doc (A-8).                                        |
| D-8 | Add headless-browser screenshot tooling (e.g. Playwright) as a devDependency.                   |
| D-9 | Commit packet PNGs (18 MB) into repo, or keep outside (recommend: outside, hashes in manifest). |

---

## 12. Independent review (Sonnet 5.5 Medium): findings and resolutions

The reviewer verified about 30 factual claims as correct (App.tsx anchors, file sizes, no editor/terminal deps, the `a11yTokens` rule, the CI 30-minute budget, stray literals, PWA colours, Tauri decorations, alpha measurements). Resolutions:

- **B1 (blocking). Rule R-1:** every Goal-derived element anywhere (Overview "Active work", run-workspace Goal panel, Reviews, nav badges, mascot state) renders from `goalApi` data through `completionStandingCopy` and `completionModel`. There is no fixed Plan/Build/Review ✓ stepper and no unqualified "complete" or ✓ for contested or unverifiable standing. Packet stage labels are illustrative; labels come from real data. The mascot progress arc reflects real phase counts only, and the row-4 "+" badge is not a success signal without owner approval. P4 "Executor disabled" is driven by real capability data (`DisabledGoalExecutor`), not copied. P4 "Review plan" is a navigation link to the existing plan view, never an authority control.
- **B2 (blocking). Rule R-2:** Reviews reuses `UnifiedApprovals` and its compact-viewport gating unchanged. Acceptance: at 375 and 390 px, Reviews cannot issue completion, correction, attestation or final-apply requests (extend `goalMobile`/`mobileStanding` tests to the route). The server stays the authority gate.
- **B3 (blocking).** Resolved in §8: server work is a separate approved non-UI stage or deferred.
- **S1.** AGENTS.md invariants now rank first in the authority order.
- **S2. Rule R-3:** "Approval before edits" binds to the existing server-honoured approval/permission field. If the server does not honour a value, the control is read-only. Turning it off must not weaken server-enforced approval (RED test).
- **S3.** Token criterion widened (§8).
- **S4.** Add a separate brightened `accent-ink` for crimson text on near-black; sampled mockup crimson is not assumed to pass 4.5:1.
- **S5. New decision D-10:** the sidebar workspace file tree (P1–P3; needs a server file listing, default = omit/defer) and the account "N" menu (default = do not build).
- **S6.** D-8 must be decided before UI.1b; every stage captures before/after screenshots, not only UI.7.
- **S7.** Rebasing rewrites SHAs, so exact-SHA CI is re-run on rebased SHAs and `docs/ui/EVIDENCE.md` is updated. The pairing fix is a named SHA/PR dependency of UI.4, recorded at base acceptance.
- **S8.** Save draft verified absent (§2.2).
- **Nits** fixed: nav count, alpha wording, remnant size, breakpoint list, typo.

Packet details the reviewer found under-specified go on the relevant stage checklist: P1 Recent-workspaces Active/Idle and Max-agents dropdown; P2 "Prompt · Markdown" footer, Context row, per-role Effort, amber availability notice, "Ctrl+Enter to plan"/"Start planning"; P3 file tabs, branch dropdown, diff gutter, Terminal/Changes/Build & Tests tabs (terminal parts deferred per D-2), PR status dot; P4 has no traffic lights or search field, unlike P1.

Review status: blocking findings are resolved in text. Next: owner decisions D-1 to D-10.

---

## 13. Supplement integration (2026-10-14 supplement, verified 2026-10-15)

Supplement: `Turing-Terminal-UI-Supplement.zip` (fonts with licences, clean mascot candidate, decision register, review-findings map, verification JSON). It states it has no repository access and no repo test results; its recommendations are **not owner approvals** and it cannot waive any stage prerequisite.

### 13.1 What I verified independently

- Font provenance: all 17 files match `font-provenance.json` SHA-256; no font file is missing from provenance. All 154 hashed entries in `MANIFEST.json` that exist on disk match.
- Mascot: 60 PNG frames, all exactly 96×96, alpha only 0 or 255, four opaque colours only; `status-atlas.png` is 576×384 and its 24 tiles equal the individual frames byte-for-byte; `wipe-atlas.png` is 576×576; SVGs contain no colour literals and use `var(--tt-mascot-*)` only.
- UnifrakturCook Bold covers the characters tested (Latin, digits, `#`, `.`, `—`, `·`, `é`).
- Not re-checked: PDF page count and the ten packet PNG hashes beyond what the supplement reports; the Linux Libertine upstream archive hash against SourceForge.

### 13.2 Findings (new, to resolve before UI.1b and UI.6)

1. **Outline token is invisible on the dark canvas.** Outline `(20,20,24)` vs a `#121216` surface is 1.02:1; body 9.9:1, shade 7.5:1. The silhouette reads through the body fill, but any "outline" role needs its own token and the skull must be checked on every real surface (nav, cards, rails).
2. **Red pips are 3.2:1 and 4×4 px.** `--tt-mascot-accent` (188,48,60) is below the 4.5:1 text bar and tiny. It is acceptable only as decoration; it must never be the sole carrier of "thinking" or "loading" (R-1, 1.4.1). A real text status stays adjacent. The mascot is `aria-hidden`.
3. **Accent is used in 14 of the 60 SVG frames** (not only `skull-base.svg`), so the `--tt-mascot-accent` token must exist in the token set and be tested; the contrast test must cover all four mascot tokens against each surface the mascot can sit on.
4. **Raster use vs token rule.** PNGs carry fixed colours and would violate "zero colour literals outside `tokens.css`" (§8). Decision: **ship inline SVG** (token-driven, crisp at integer scales) and keep PNG/atlases out of the app bundle unless a specific need (e.g. PWA icon) is approved. Raster assets are then an allow-listed exception with a documented palette check.
5. **Wipe row 4 (bottom-to-top) frames 3–4 look glitchy** in `preview.png` (comb-shaped intermediate). Visual acceptance item for the owner before UI.6.
6. **Blackletter is dynamic-text risk.** The packet's P4 shows a _Goal title_ in blackletter. Goal and project names are user content. Rule R-4: display face only on static, allow-listed strings (wordmark, fixed page titles); dynamic titles use the reading face. A CSS-grep test enforces the allow-list. UnifrakturCook has only 271 glyphs (no Latin-extended/Cyrillic/CJK); fallbacks must not mix scripts mid-heading.
7. **Font licence handling.** UnifrakturCook is OFL 1.1 **with a Reserved Font Name**: do not subset, convert or otherwise modify it in the build (e.g. fontsource/pyftsubset pipelines) and keep the name, or rename. Linux Libertine is dual OFL / GPL-with-font-exception; ship `OFL-1.1.txt`, `GPL.txt`, `LICENCE.txt`, README and the UnifrakturCook `OFL.txt` with the binaries and add a third-party notices entry (also relevant to `package:scan`/installer notices, to be verified in UI.1b). Not a legal opinion.
8. **Payload.** Libertine WOFF total is 1.29 MB (four styles). The PWA precaches static assets; use only styles actually used (Regular, Bold, Italic initially), `font-display: swap`, and measure precache growth. WOFF2 conversion is a modification-free container change for Libertine but is a modification for the RFN font: decide with the owner. CSP already allows `font-src 'self' data:`.
9. **Reappearance** (reversed wipe) is unsupplied; keep it out of scope or specify it as reviewed reverse playback. No success/failure art exists; none is to be invented (D-4).
10. **Preview files** (`preview.html`, `preview.png`) are documentation, not app styles; not to be committed.

### 13.3 Updated decision table

Legend: **Confirmed** = owner-stated requirement; **Recommended** = proposal, not approved; **Open** = needs an owner decision; **Blocked**.

| ID   | Status                                            | Resolution as it stands                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | **Open / Blocked**                                | No accepted base. Goal Engine is accepted stage-by-stage (e.g. 7C.2A frozen at `3a69f33`, 7C.2B.3 backend baseline) but `V1_READINESS` on the branch does not mark the whole Goal Engine accepted; PR #3 is open; tip moved to `67af34f` (CI in progress at check time; previous tip `392064d` CI green). The readiness text records HR-Q4 as "fixed in code, still a blocker until owner acceptance". No SHA may be chosen without the owner's explicit acceptance statement. |
| D-2  | Recommended                                       | Read-only run workspace; editor and terminal deferred.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-3  | Fonts sourced; **visual acceptance pending**      | Libertine confirmed by owner. UnifrakturCook Bold is a candidate, not an identified match to the reference font; owner must accept it visually (preview.png shows a plausible but unreviewed match). Licence handling per 13.2 (7)–(8).                                                                                                                                                                                                                                        |
| D-4  | Confirmed art direction; clean redraw = candidate | Only idle/thinking/loading/neutral phase-transition/wipes. No success/complete animation. The clean redraw is not an exact trace of the concept PNG and needs owner visual acceptance (incl. 13.2 (5)).                                                                                                                                                                                                                                                                        |
| D-5  | Recommended                                       | Nav union with mapping to real routes; no empty destinations (stronger than my earlier text: each nav item must land on an implemented page or be omitted).                                                                                                                                                                                                                                                                                                                    |
| D-6  | Recommended                                       | Minimal Ctrl/Cmd+K navigation palette; no invented commands.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D-7  | Recommended (dark direction confirmed)            | Dark-only in this overhaul.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-8  | Recommended; **needs install approval**           | Playwright with deterministic fixtures before UI.1b; adding a devDependency (and browser binary download) is an owner-visible change and must fit the 30-minute CI budget; screenshots may run outside CI.                                                                                                                                                                                                                                                                     |
| D-9  | Recommended                                       | Keep concept PNGs outside the repo; commit hashes, licences, provenance and only assets the app consumes (fonts, inline SVG frames, animation manifest).                                                                                                                                                                                                                                                                                                                       |
| D-10 | Recommended                                       | Defer sidebar file tree and account menu.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 13.4 Mascot implementation notes (UI.6)

- Frame data from `animation-manifest.json`: idle 6×300 ms loop; thinking and loading 6×150 ms loops; phase-transition and wipes 6×70 ms single pass; frame six of a wipe is one 4×4 px grey block held one interval, then the mascot unmounts. Timings are candidates, not progress measurements.
- Deterministic playback via an injected clock (fake timers in tests); `prefers-reduced-motion: reduce` shows frame 1 statically with real text status and skips wipes.
- Rendering: inline SVG, `shape-rendering: crispEdges`, integer scale, no filters/shadows (they recreate the removed haze); fixed slot to prevent layout shift; never inside alert/approval/error regions.
- The status animations are bound to real activity selectors (run/stage running, provider loading), never to a Goal's completion; a stopped spinner or hidden mascot never implies completion.

### 13.5 Permitted next stage

Unchanged: nothing from UI.1 onward may start until D-1 is resolved by the owner. Allowed now without D-1 (no shared source touched): owner visual acceptance of the font and mascot candidates (D-3/D-4); licence/notice plan; a mascot slicing task is **no longer needed** because the clean candidate replaces it, so M-0 reduces to integrating the accepted frames as inline SVG after acceptance.
