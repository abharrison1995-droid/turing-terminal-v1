import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures } from './fixtures/mockApi';
import { populatedRoutes } from './fixtures/populated';

/**
 * UI.1c evidence capture (UI1C_SCOPE section 6). Fixture-only and deterministic: every API call is answered from
 * `fixtures/populated.ts`, which is labelled as invented data. The viewport, dark scheme, reduced motion and blocked
 * service workers come from `playwright.config.ts`.
 *
 * Not part of `npm test` (vitest excludes e2e/) or the CI gate. Run with:
 *   npx playwright test -c e2e/playwright.config.ts e2e/ui1c.spec.ts
 * Images are written to docs/ui/evidence/ui1c/after/ as `<screen>-<viewport>.png`.
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui1c/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const DESKTOP: ViewportName = 'desktop-1440x900';
const PHONE: ViewportName = 'iphone-390x844';

async function openApp(page: Page, viewport: ViewportName) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, populatedRoutes);
  // Freeze the fake clock one second after FIXED_NOW. Otherwise elapsed-time labels tick in real time and two captures
  // of the same state can differ by a second. runFor() still fires timers while paused (used by the stale-banner test).
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  return api;
}

/**
 * The shell is ready once the top-bar title renders. A level-1 heading is not used: the compact Home has none (its
 * main region opens with an "Approval required" h2), so waiting on a heading would fail on a correct page.
 */
async function ready(page: Page) {
  await expect(page.locator('.topbar-title')).toBeVisible();
}

/**
 * Writes a frame only once two consecutive screenshots match. Overlay captures (palette, navigation guard) were seen to
 * alternate between two renders across runs, so a single screenshot could land mid-state.
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

const screens = [
  { screen: 'home', label: null, marker: 'Fixture: commit the reviewed CSV v2 changes' },
  { screen: 'runs', label: 'Runs & history', marker: 'Fixture Ledger UI' },
  { screen: 'grand-projects', label: 'Grand Projects', marker: 'Fixture: harden Atlas client retries' },
  { screen: 'settings', label: 'Settings', marker: 'Fixture rule: keep diffs small' },
] as const;

for (const viewport of [DESKTOP, PHONE]) {
  for (const { screen, label, marker } of screens) {
    test(`${screen} shows populated fixtures at ${viewport}`, async ({ page }) => {
      const api = await openApp(page, viewport);
      await page.goto('/');
      await ready(page);
      if (label) await goTo(page, viewport, label);
      await expect(page.getByText(marker).first()).toBeVisible();
      expect(api.unmapped, 'every API call must be answered by a populated fixture').toEqual([]);
      await capture(page, `${screen}-${viewport}`);
    });
  }
}

test('command palette opens on desktop with Ctrl+K', async ({ page }) => {
  const api = await openApp(page, DESKTOP);
  await page.goto('/');
  await ready(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  expect(api.unmapped).toEqual([]);
  await capture(page, `palette-${DESKTOP}`);
});

test('command palette opens from the trigger on the phone shell', async ({ page }) => {
  const api = await openApp(page, PHONE);
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  expect(api.unmapped).toEqual([]);
  await capture(page, `palette-${PHONE}`);
});

test('navigation drawer opens on the phone shell', async ({ page }) => {
  const api = await openApp(page, PHONE);
  await page.goto('/');
  await ready(page);
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  expect(api.unmapped).toEqual([]);
  await capture(page, `drawer-${PHONE}`);
});

test('leaving an unsaved Grand Project draft shows the navigation guard', async ({ page }) => {
  const api = await openApp(page, DESKTOP);
  await page.goto('/');
  await goTo(page, DESKTOP, 'Grand Projects');
  await page.getByRole('button', { name: 'New Grand Project' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Fixture draft title');
  await goTo(page, DESKTOP, 'Settings');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  expect(api.unmapped).toEqual([]);
  await capture(page, `nav-guard-${DESKTOP}`);
});

test('first-load failure shows the error state, not stale data', async ({ page }) => {
  await openApp(page, DESKTOP);
  await page.route('**/api/dashboard', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Fixture: the master returned HTTP 500 on first load.' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load the workspace' })).toBeVisible();
  await capture(page, `first-load-error-${DESKTOP}`);
});

test('a failed refresh after a good load shows the stale-data banner', async ({ page }) => {
  await openApp(page, DESKTOP);
  let dashboardCalls = 0;
  await page.route('**/api/dashboard', (route) => {
    dashboardCalls += 1;
    // The first load falls through to the populated fixture; every later refresh fails.
    if (dashboardCalls === 1) return route.fallback();
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Fixture: refresh failed after a good load.' }),
    });
  });
  await page.goto('/');
  await expect(page.getByText('Fixture Atlas API').first()).toBeVisible();
  await page.clock.runFor(7_000);
  await expect(page.getByText('Showing last known data')).toBeVisible();
  expect(dashboardCalls).toBeGreaterThan(1);
  await capture(page, `stale-banner-${DESKTOP}`);
});
