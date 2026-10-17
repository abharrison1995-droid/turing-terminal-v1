import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW, emptyDashboard } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import { FIXTURE_TASK } from './fixtures/populated';
import { ui5Routes } from './fixtures/ui5';

/**
 * UI.6 mascot evidence (UI6_SCOPE). Fixture-only and deterministic: every `/api/*` request is answered by the UI.5 route
 * table (`fixtures/ui5.ts`), except where a state needs a request held open (loading, preview) or an empty dashboard (the
 * idle Runs page). The clock is paused one second after FIXED_NOW, so the mascot's own `setTimeout` frame timer only moves
 * when a test advances it with `page.clock.runFor`.
 *
 * Four states, each at 1440x900, 390x844 and 375x812:
 *   loading          the first dashboard request is held, so the Loading view shows the loading mark        (48 px)
 *   composer-preview the run preview request is held, so the composer shows the thinking mark              (24 px)
 *   run-running      the running fixture run's detail shows the thinking mark beside its title              (24 px)
 *   runs-empty-idle  the Runs page with no runs shows the idle mark as the empty-state heading              (48 px)
 *
 * Motion tests run with reduced motion off. Each one captures the frame-0 page, then steps six frames (300 ms per step for
 * idle, 150 ms for thinking and loading), reads the svg's markup and box at each step, and stitches the frames into one
 * strip per animation through an HTML contact sheet. Reduced-motion tests run with reduced motion on: the svg markup must not
 * change over two seconds of fake time.
 *
 * Images are written to docs/ui/evidence/ui6/after/. Frame PNGs for the strips are kept in e2e/.artifacts/ui6-frames/,
 * which is gitignored. Run with:
 *   npm run e2e:screenshots -- e2e/ui6.spec.ts
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui6/after/', import.meta.url));
const FRAMES = fileURLToPath(new URL('./.artifacts/ui6-frames/', import.meta.url));
mkdirSync(OUT, { recursive: true });
mkdirSync(FRAMES, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES: ViewportName[] = ['desktop-1440x900', 'iphone-390x844', 'iphone-375x812'];

/** Frame durations from docs/ui/MASCOT_PROVENANCE.json (runtime.frameMs) and six frames per animation. */
const STEP_MS = { idle: 300, thinking: 150, loading: 150 } as const;
type Animation = keyof typeof STEP_MS;
const FRAME_COUNT = 6;

/** The running fixture run. Its detail shows the thinking mark beside "Running · elapsed". */
const RUNNING_RUN = 'fixture-run-001';

const LOADING_LABEL = 'Connecting to the local master…';
const PREVIEW_LABEL = 'Preparing run preview…';
const RUNNING_LABEL = /^Running · /;
const IDLE_LABEL = 'No runs yet';

type StateName = 'loading' | 'composer-preview' | 'run-running' | 'runs-empty-idle';

interface StateSpec {
  animation: Animation;
  /** The label beside the mark. A string is matched exactly, a RegExp by pattern. */
  label: string | RegExp;
  /** Whether this state supplies the strip for its animation. One strip per animation, so preview does not repeat thinking. */
  strip: boolean;
}

const STATES: Record<StateName, StateSpec> = {
  loading: { animation: 'loading', label: LOADING_LABEL, strip: true },
  'composer-preview': { animation: 'thinking', label: PREVIEW_LABEL, strip: false },
  'run-running': { animation: 'thinking', label: RUNNING_LABEL, strip: true },
  'runs-empty-idle': { animation: 'idle', label: IDLE_LABEL, strip: true },
};

/** The UI.5 route table, unchanged, except that the idle state answers the dashboard with an empty snapshot. */
function routesFor(state: StateName): Record<string, unknown> {
  return state === 'runs-empty-idle' ? { ...ui5Routes, '/api/dashboard': emptyDashboard } : ui5Routes;
}

/** The shell is ready once the top-bar title renders. */
async function ready(page: Page) {
  await expect(page.locator('.topbar-title')).toBeVisible();
}

/** Opens a Workspace destination. The drawer is the navigation on the phone; the sidebar is used on desktop. */
async function goTo(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  if (!(await nav.first().isVisible())) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await nav.getByRole('button', { name: new RegExp(`^${escaped}`) }).click();
}

async function openHome(page: Page) {
  await page.goto('/');
  await ready(page);
}

/** Selects a run from the Runs list. Its detail opens on the Activity tab. */
async function openRun(page: Page, runId: string) {
  await openHome(page);
  await goTo(page, 'Runs & history');
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.getByRole('tablist', { name: 'Run sections' })).toBeVisible();
}

/**
 * Installs the fixtures, pins the clock, and drives the page to one state. Holds are registered after the fixture
 * router, so they take precedence over it: a held request never answers, which keeps the state on screen.
 */
async function reachState(page: Page, viewport: ViewportName, state: StateName): Promise<MockApi> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, routesFor(state));
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  switch (state) {
    case 'loading': {
      await page.route('**/api/dashboard', () => {
        // Held on purpose: the first load stays pending for the capture.
      });
      await page.goto('/');
      await expect(page.getByText(LOADING_LABEL, { exact: true })).toBeVisible();
      break;
    }
    case 'composer-preview': {
      await openHome(page);
      await page.route('**/api/runs/preview', () => {
        // Held on purpose: the preview stays in flight for the capture.
      });
      await page.locator('#task-input').fill(FIXTURE_TASK);
      await page.getByRole('button', { name: 'Review run preview' }).click();
      await expect(page.getByText(PREVIEW_LABEL, { exact: true })).toBeVisible();
      break;
    }
    case 'run-running': {
      await openRun(page, RUNNING_RUN);
      await expect(page.locator('.thread-state svg[data-mascot]')).toBeVisible();
      break;
    }
    case 'runs-empty-idle': {
      await openHome(page);
      await goTo(page, 'Runs & history');
      await expect(page.getByRole('heading', { name: IDLE_LABEL })).toBeVisible();
      break;
    }
  }
  return api;
}

/** The one mascot on the page, its label, and the overlay and page-width checks that apply to every state. */
async function expectMark(page: Page, label: string | RegExp): Promise<Locator> {
  const svg = page.locator('svg[data-mascot]');
  await expect(svg, 'exactly one mascot on the page').toHaveCount(1);
  await expect(svg).toHaveAttribute('aria-hidden', 'true');
  await expect(svg).toBeVisible();

  const labelEl = svg.locator('xpath=..').locator('.mascot-status-label');
  await expect(labelEl).toBeVisible();
  await expect(labelEl).toHaveText(label);

  const inOverlay = await page
    .locator('[role="alert"] svg[data-mascot], [role="dialog"] svg[data-mascot]')
    .count();
  expect(inOverlay, 'no mascot inside an alert or dialog').toBe(0);
  return svg;
}

async function expectNoOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, 'no horizontal page overflow').toBeLessThanOrEqual(widths.client);
}

/** Writes a frame only once two consecutive screenshots match, so a late render cannot land mid-state. */
async function capture(page: Page, file: string) {
  await page.evaluate(() => document.fonts.ready);
  let previous = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(200);
    const next = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    if (next.equals(previous)) {
      writeFileSync(`${OUT}${file}.png`, next);
      return;
    }
    previous = next;
  }
  throw new Error(`${file} did not settle into a stable frame`);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Steps the clock one frame at a time and reads the mark's markup, box and pixels at each step (frame 0 first). */
async function stepFrames(page: Page, animation: Animation) {
  const svg = page.locator('svg[data-mascot]');
  // The element screenshot scrolls the mark into view. Doing it first keeps the page still, so every box is read at the same scroll.
  await svg.scrollIntoViewIfNeeded();
  const frames: Buffer[] = [];
  const boxes: (Box | null)[] = [];
  const markups: string[] = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    if (index > 0) {
      await page.clock.runFor(STEP_MS[animation]);
      // Real time, so React can commit the new frame. Playwright's fake timers do not run here.
      await page.waitForTimeout(100);
    }
    boxes.push(await svg.boundingBox());
    markups.push(await svg.evaluate((element) => element.outerHTML));
    frames.push(await clipShot(page, boxes[index]));
  }
  return { frames, boxes, markups };
}

/**
 * A page-level screenshot clipped to a box measured just before. Playwright's element screenshot can scroll the page to
 * the bottom while it captures, which moves the mark between frames, so the frames are cut from the viewport instead.
 */
async function clipShot(page: Page, box: Box | null): Promise<Buffer> {
  if (!box) throw new Error('the mark has no box to capture');
  return page.screenshot({ animations: 'disabled', caret: 'hide', clip: box });
}

/**
 * Writes the six frames to the gitignored frames directory, then lays them out in one HTML contact sheet and screenshots
 * it. Each frame is shown at 96 px with pixelated scaling and labelled with its fake-time offset.
 */
async function writeStrip(page: Page, animation: Animation, viewport: ViewportName, frames: Buffer[]) {
  frames.forEach((frame, index) => writeFileSync(`${FRAMES}${animation}-${viewport}-${index}.png`, frame));
  const cells = frames
    .map(
      (frame, index) =>
        `<figure><img alt="" src="data:image/png;base64,${frame.toString('base64')}"><figcaption>frame ${index} · ${index * STEP_MS[animation]} ms</figcaption></figure>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #0d0d0f; color: #cfcfd4; font: 12px ui-monospace, Menlo, monospace; }
    #strip { display: flex; gap: 16px; padding: 16px; width: max-content; align-items: flex-end; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    img { width: 96px; height: 96px; image-rendering: pixelated; background: #1a1a1f; }
  </style></head><body><div id="strip"><div style="display:flex;gap:16px">${cells}</div></div></body></html>`;
  await page.setContent(html);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page
    .locator('#strip')
    .screenshot({ path: `${OUT}strip-${animation}-${viewport}.png`, animations: 'disabled' });
}

function motionTest(state: StateName, viewport: ViewportName) {
  const spec = STATES[state];
  test(`${state} motion frames at ${viewport}`, async ({ page }) => {
    const api = await reachState(page, viewport, state);
    await expectMark(page, spec.label);
    await expectNoOverflow(page);
    // Frame 0 is the still image. Capture it before the clock moves.
    await capture(page, `${state}-${viewport}`);

    const { frames, boxes, markups } = await stepFrames(page, spec.animation);
    expect(new Set(markups).size, 'the mark advances across six frames').toBeGreaterThan(1);
    expect(boxes, 'the slot box is identical in every frame').toEqual(
      Array.from({ length: FRAME_COUNT }, () => boxes[0]),
    );
    expect(boxes[0], 'the mark has a box').not.toBeNull();
    await expectNoOverflow(page);
    expect(api.unmapped, 'every API call is answered by a fixture or a held route').toEqual([]);

    if (spec.strip) await writeStrip(page, spec.animation, viewport, frames);
  });
}

function reducedMotionTest(state: StateName, viewport: ViewportName) {
  const spec = STATES[state];
  test(`${state} reduced motion at ${viewport}`, async ({ page }) => {
    const api = await reachState(page, viewport, state);
    const svg = await expectMark(page, spec.label);
    await expectNoOverflow(page);

    const markupBefore = await svg.evaluate((element) => element.outerHTML);
    const boxBefore = await svg.boundingBox();
    await page.clock.runFor(2_000);
    await page.waitForTimeout(100);
    const markupAfter = await svg.evaluate((element) => element.outerHTML);
    const boxAfter = await svg.boundingBox();

    expect(markupAfter, 'the svg markup is unchanged over 2 s under reduced motion').toBe(markupBefore);
    expect(boxAfter, 'the slot box is unchanged over 2 s under reduced motion').toEqual(boxBefore);
    await expectNoOverflow(page);
    expect(api.unmapped, 'every API call is answered by a fixture or a held route').toEqual([]);

    writeFileSync(
      `${OUT}mark-${state}-reduced-motion-${viewport}.png`,
      await clipShot(page, await svg.locator('xpath=..').boundingBox()),
    );
  });
}

test.describe('motion on, frame-driven', () => {
  test.use({ reducedMotion: 'no-preference' });
  for (const viewport of VIEWPORT_NAMES) {
    for (const state of Object.keys(STATES) as StateName[]) {
      motionTest(state, viewport);
    }
  }
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  for (const viewport of VIEWPORT_NAMES) {
    for (const state of Object.keys(STATES) as StateName[]) {
      reducedMotionTest(state, viewport);
    }
  }
});
