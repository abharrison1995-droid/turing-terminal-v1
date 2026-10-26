import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import { goalCockpitRoutes } from './fixtures/goals';

/**
 * UI.3 evidence capture (UI3_SCOPE section 6). Fixture-only and deterministic: every API call is answered from
 * `fixtures/goals.ts` (on top of `populated.ts`), whose values are invented and labelled as fixtures. Viewport, dark
 * scheme, reduced motion and blocked service workers come from `playwright.config.ts`; the clock and the stable-frame
 * capture are the same as `home-run.spec.ts`.
 *
 * Not part of `npm test` (vitest excludes e2e/) or the CI gate. Run with:
 *   npx playwright test -c e2e/playwright.config.ts e2e/goal-cockpit.spec.ts
 * Images are written to docs/ui/evidence/ui3/after/ as `<capture>-<viewport>.png`.
 *
 * Tabs and the handoff are captured on desktop only. Completion, correction, attestation and final-apply are desktop-only
 * by design, so the phone captures show the standing and the list, and the phone test asserts that no completion control
 * exists in the DOM. The desktop completion standing is captured on the Handoff tab, after the user chooses the attestation.
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui3/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const DESKTOP: ViewportName = 'desktop-1440x900';
const PHONE: ViewportName = 'iphone-390x844';
const VIEWPORT_NAMES: ViewportName[] = [DESKTOP, PHONE];

/** Named by the cockpit's own copy. Any of these on a phone would be a completion, correction, attestation or apply control. */
const COMPLETION_CONTROL =
  /Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request|Apply|Attest|Approve definition/i;
const COMPLETION_PATH =
  /(completion|completion-preflight|completion-decision|corrections|attestation-corrections|handoffs)/;

/** Goal rows, named by their fixture titles (Playwright matches a substring of the accessible name). */
const ROWS = {
  ledger: 'Fixture: CSV v2 ledger export',
  active: 'Fixture: retry backoff for the Atlas client',
  handoff: 'Fixture: docs search index refresh',
  contested: 'Fixture: export schema migration',
  legacy: 'Fixture: JSON output for the status command',
} as const;

async function openApp(page: Page, viewport: ViewportName) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, goalCockpitRoutes);
  // Freeze the fake clock one second after FIXED_NOW, as in ui1c and ui2, so elapsed-time labels cannot drift.
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  return api;
}

/** The shell is ready once the top-bar title renders. */
async function ready(page: Page) {
  await expect(page.locator('.topbar-title')).toBeVisible();
}

/** Writes a frame only once two consecutive screenshots match, so an overlay or a focus move cannot land mid-state. */
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
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click();
}

/** On the compact shell the first heading in main must be an h1. Desktop is not held to this. */
async function expectH1First(page: Page) {
  const tag = await page
    .locator('main :is(h1, h2, h3, h4, h5, h6)')
    .first()
    .evaluate((node) => node.tagName);
  expect(tag, 'the first heading in main must be an h1 at compact width').toBe('H1');
}

/** Shared end of every capture: heading order on the compact shell, no unanswered API call, then the frame. */
async function settle(page: Page, viewport: ViewportName, api: MockApi, file: string) {
  if (viewport === PHONE) await expectH1First(page);
  expect(api.unmapped, 'every API call must be answered by a fixture').toEqual([]);
  await page.mouse.move(0, 0);
  await capture(page, `${file}-${viewport}`);
}

/** Opens the Grand Projects list and waits for its rows. */
async function openList(page: Page, viewport: ViewportName) {
  await page.goto('/');
  await ready(page);
  await goTo(page, viewport, 'Grand Projects');
  await expect(page.getByRole('heading', { level: 1, name: 'Grand Projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: ROWS.active })).toBeVisible();
}

/** Opens one Goal from the list. The cockpit heading carries the Goal title on both shells. */
async function openGoal(page: Page, viewport: ViewportName, title: string) {
  await openList(page, viewport);
  await page.getByRole('button', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** The visible text of every button on the page, in DOM order. */
async function buttonNames(page: Page): Promise<string[]> {
  return (await page.getByRole('button').allTextContents()).map((text) => text.trim());
}

/** The buttons on the page that COMPLETION_CONTROL names: completion, correction, attestation and apply controls. */
async function completionControls(page: Page): Promise<string[]> {
  return (await buttonNames(page)).filter((name) => COMPLETION_CONTROL.test(name));
}

for (const viewport of VIEWPORT_NAMES) {
  test(`grand projects list at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openList(page, viewport);
    await expect(page.getByText('Needs you').first()).toBeVisible();
    await settle(page, viewport, api, 'list');
  });

  test(`active cockpit at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openGoal(page, viewport, ROWS.active);
    // Mixed milestone statuses, no percentage: the active milestone and the satisfied ones are named in text.
    await expect(page.getByText('Retry policy').first()).toBeVisible();
    await settle(page, viewport, api, 'cockpit-active');
  });

  test(`needs-user cockpit at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openGoal(page, viewport, ROWS.ledger);
    await expect(page.locator('[aria-label="Approvals for this Goal"]')).toBeVisible();
    await settle(page, viewport, api, 'cockpit-needs-user');
  });
}

test(`contested completion standing at ${PHONE}`, async ({ page }) => {
  const api = await openApp(page, PHONE);
  await openGoal(page, PHONE, ROWS.contested);
  await expect(page.getByRole('region', { name: 'Completion standing' })).toBeVisible();
  await expect(page.getByText(/contested/i).first()).toBeVisible();
  await settle(page, PHONE, api, 'completion-contested');
});

test(`legacy completion standing at ${PHONE}`, async ({ page }) => {
  const api = await openApp(page, PHONE);
  await openGoal(page, PHONE, ROWS.legacy);
  await expect(page.getByRole('region', { name: 'Completion standing' })).toBeVisible();
  await settle(page, PHONE, api, 'completion-legacy');
});

test(`definitions tab at ${DESKTOP}`, async ({ page }) => {
  const api = await openApp(page, DESKTOP);
  await openGoal(page, DESKTOP, ROWS.active);
  await page.getByRole('tab', { name: 'Definitions' }).click();
  await expect(page.getByRole('tab', { name: 'Definitions' })).toHaveAttribute('aria-selected', 'true');
  await settle(page, DESKTOP, api, 'definitions-tab');
});

test(`handoff tab with diff at ${DESKTOP}`, async ({ page }) => {
  const api = await openApp(page, DESKTOP);
  await openGoal(page, DESKTOP, ROWS.handoff);
  await page.getByRole('tab', { name: 'Handoff' }).click();
  await expect(page.getByRole('tab', { name: 'Handoff' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Ready for manual integration' })).toBeVisible();
  await settle(page, DESKTOP, api, 'handoff-tab');
});

// Desktop: the completion standing sits in the Handoff tab, under the attestation the user chooses. The fixture records one
// eligible decision, so the standing and its Complete control both render. The helper that the phone test uses must find
// that control here. Without this positive control, an empty phone result could only mean the helper never matches.
test(`completion standing on the handoff tab at ${DESKTOP}`, async ({ page }) => {
  const api = await openApp(page, DESKTOP);
  await openGoal(page, DESKTOP, ROWS.handoff);
  await page.getByRole('tab', { name: 'Handoff' }).click();
  await expect(page.getByRole('heading', { name: 'Ready for manual integration' })).toBeVisible();
  await page.locator('.goal-external-history .goal-version').first().click();
  const review = page.getByRole('region', { name: 'Completion review' });
  await expect(review).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete Goal' })).toBeVisible();
  expect(
    await completionControls(page),
    'the desktop completion review must offer a completion control',
  ).toContain('Complete Goal');
  // The click scrolls the attestation row into view. Bring the review itself into the frame for the capture.
  await review.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await settle(page, DESKTOP, api, 'completion-standing');
});

test(`phone cockpits expose no completion control and fetch no completion path`, async ({ page }) => {
  const api = await openApp(page, PHONE);
  for (const [key, title] of Object.entries(ROWS)) {
    await openGoal(page, PHONE, title);
    // Wait for the cockpit's own regions before counting, so no count is read while the cockpit is still rendering.
    await expect(page.locator('[aria-label="Approvals for this Goal"]')).toBeVisible();
    if (key === 'contested' || key === 'legacy') {
      await expect(page.getByRole('region', { name: 'Completion standing' })).toBeVisible();
    }
    await expect(page.locator('.goal-completion, .goal-completion-action, .goal-confirm')).toHaveCount(0);
    const cockpit = page.locator('.goal-mobile-cockpit');
    await expect(cockpit.getByRole('checkbox')).toHaveCount(0);
    await expect(cockpit.getByRole('textbox')).toHaveCount(0);
    await expect(cockpit.getByRole('combobox')).toHaveCount(0);
    expect(await completionControls(page), `no completion control on the phone cockpit for ${title}`).toEqual(
      [],
    );
  }
  expect(
    api.calls.filter((call) => COMPLETION_PATH.test(call)),
    'the phone cockpit must not request completion paths',
  ).toEqual([]);
});
