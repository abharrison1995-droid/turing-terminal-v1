import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import { FIXTURE_TASK, homeRunRoutes, ui2Variants } from './fixtures/populated';

/**
 * UI.2 evidence capture (UI2_SCOPE section 4). Fixture-only and deterministic: every API call is answered from
 * `fixtures/populated.ts`, whose values are invented and labelled as fixtures. Viewport, dark scheme, reduced motion and
 * blocked service workers come from `playwright.config.ts`; the clock and the two-identical-frames capture are the same
 * as `shell.spec.ts`.
 *
 * Not part of `npm test` (vitest excludes e2e/) or the CI gate. Run with:
 *   npx playwright test -c e2e/playwright.config.ts e2e/home-run.spec.ts
 * Images are written to docs/ui/evidence/ui2/after/ as `<capture>-<viewport>.png`.
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui2/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const DESKTOP: ViewportName = 'desktop-1440x900';
const PHONE: ViewportName = 'iphone-390x844';
const VIEWPORT_NAMES: ViewportName[] = [DESKTOP, PHONE];

/** Failed in its Test stage. Its Changes tab has a three-file diff. */
const FAILED_RUN = 'fixture-run-005';
/** Running in its Implement stage. */
const RUNNING_RUN = 'fixture-run-001';

async function openApp(page: Page, viewport: ViewportName, routes: Record<string, unknown> = homeRunRoutes) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, routes);
  // Freeze the fake clock one second after FIXED_NOW, as in ui1c, so elapsed-time labels cannot drift between frames.
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  return api;
}

/** The shell is ready once the top-bar title renders. */
async function ready(page: Page) {
  await expect(page.locator('.topbar-title')).toBeVisible();
}

/**
 * Writes a frame only once two consecutive screenshots match, so an overlay or a focus move cannot land mid-state.
 */
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

/** Opens a Workspace destination from the sidebar, or from the drawer on the compact shell. */
async function goTo(page: Page, viewport: ViewportName, label: string) {
  if (viewport === PHONE) await page.getByRole('button', { name: 'Open navigation' }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click();
}

async function openHome(page: Page) {
  await page.goto('/');
  await ready(page);
}

/** Selects a run from the Runs list. Its detail opens on the Activity tab. */
async function openRun(page: Page, viewport: ViewportName, runId: string) {
  await goTo(page, viewport, 'Runs & history');
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page.getByRole('tablist', { name: 'Run sections' })).toBeVisible();
}

/** Types the fixture task and asks for a preview with the composer's own button. */
async function requestPreview(page: Page) {
  await page.locator('#task-input').fill(FIXTURE_TASK);
  await page.getByRole('button', { name: 'Review run preview' }).click();
}

/**
 * On the compact shell the first heading in main must be an h1. Desktop is not held to this, because its h1 is
 * the visible Home title and the check only guards the reordered compact DOM.
 */
async function expectH1First(page: Page) {
  const tag = await page
    .locator('main :is(h1, h2, h3, h4, h5, h6)')
    .first()
    .evaluate((node) => node.tagName);
  expect(tag, 'the first heading in main must be an h1 at compact width').toBe('H1');
}

/**
 * Shared end of every capture: heading order on the compact shell, no unanswered API call, then the frame. The pointer
 * is moved to the corner first, because the last click otherwise leaves a hover background on whatever it landed on.
 */
async function settle(page: Page, viewport: ViewportName, api: MockApi, file: string) {
  if (viewport === PHONE) await expectH1First(page);
  expect(api.unmapped, 'every API call must be answered by a populated fixture').toEqual([]);
  await page.mouse.move(0, 0);
  await capture(page, `${file}-${viewport}`);
}

for (const viewport of VIEWPORT_NAMES) {
  test(`home shows blockers at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    const blockers = page.getByRole('heading', { name: /Before you can run/ });
    await expect(blockers).toBeAttached();
    // On the compact shell the group sits below the first screen, so it is scrolled into view for this capture. Its
    // position at the top of the page is described in the evidence notes, not hidden by the capture.
    await blockers.scrollIntoViewIfNeeded();
    await expect(blockers).toBeVisible();
    await settle(page, viewport, api, 'home-blockers');
  });

  test(`ready run preview at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await requestPreview(page);
    await expect(page.getByRole('heading', { name: 'Ready to hand off' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start workflow' })).toBeEnabled();
    await settle(page, viewport, api, 'preview-ready');
  });

  test(`needs-setup run preview at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport, { ...homeRunRoutes, ...ui2Variants.needsSetup });
    await openHome(page);
    await requestPreview(page);
    await expect(page.getByRole('heading', { name: 'Setup needed before this can start' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start workflow' })).toBeDisabled();
    await settle(page, viewport, api, 'preview-needs-setup');
  });

  test(`composer options open at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await expect(page.locator('#composer-options')).toBeVisible();
    await settle(page, viewport, api, 'options-open');
  });

  test(`failed run activity at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await openRun(page, viewport, FAILED_RUN);
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Fixture: 2 tests failed in ledger-totals.test.ts.').first()).toBeVisible();
    await settle(page, viewport, api, 'failed-run-activity');
  });

  test(`failed run changes at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await openRun(page, viewport, FAILED_RUN);
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByRole('heading', { name: 'fixture/ledger/totals.ts' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'fixture/docs/ledger-totals.md' })).toBeVisible();
    await settle(page, viewport, api, 'failed-run-changes');
  });

  test(`running run at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await openRun(page, viewport, RUNNING_RUN);
    await expect(page.getByText('Now: Implement')).toBeVisible();
    await settle(page, viewport, api, 'running-run');
  });

  test(`truncated diff at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport, { ...homeRunRoutes, ...ui2Variants.truncatedDiff });
    await openHome(page);
    await openRun(page, viewport, FAILED_RUN);
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByText('Turing truncated this diff. Only the part it kept is shown.')).toBeVisible();
    await expect(page.getByText('Fixture: the diff stopped at the server size limit.')).toBeVisible();
    await settle(page, viewport, api, 'truncated-diff');
  });

  test(`run details error at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    // Registered after installFixtures, so it takes precedence for this one request and nothing else.
    await page.route(`**/api/runs/${FAILED_RUN}`, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Fixture: the run detail request failed.' }),
      }),
    );
    await openHome(page);
    await openRun(page, viewport, FAILED_RUN);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Run details could not be loaded' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await settle(page, viewport, api, 'details-error');
  });
}
