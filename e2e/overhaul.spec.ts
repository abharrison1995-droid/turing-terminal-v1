import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installFixtures } from './fixtures/mockApi';
import { mobileRoutes } from './fixtures/mobile';

// Real React UI, invented fixtures, no Master/provider/device claims. Two batched visual rounds at most.
const out = fileURLToPath(new URL('../artifacts/ui-overhaul-2026-10-25/', import.meta.url));
mkdirSync(out, { recursive: true });
const routes = {
  ...mobileRoutes,
  '/api/opportunities': { observations: [], retentionDays: 90, refreshRequired: false },
  '/api/opportunities/admission-targets': { targets: [] },
};
const surfaces = [
  ['home', null],
  ['projects', 'Projects'],
  ['goals', 'Grand Projects'],
  ['runs', 'Runs & history'],
  ['workflows', 'Workflows'],
  ['usage', 'Usage'],
  ['machines', 'Machines'],
  ['settings', 'Settings'],
] as const;

async function navigate(page: Page, label: string) {
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation' });
  if (!(await sidebar.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await sidebar.getByRole('button', { name: new RegExp(`^${escaped}(?:$|[\\s\\d])`) }).click();
  await expect(page.locator('.topbar-title')).toHaveText(label);
}

async function verifyAndCapture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('main h1')).toHaveCount(1);
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    main:
      (document.querySelector('main')?.scrollWidth ?? 0) - (document.querySelector('main')?.clientWidth ?? 0),
  }));
  expect(overflow.document, `${name}: document overflow`).toBeLessThanOrEqual(1);
  expect(overflow.main, `${name}: content overflow`).toBeLessThanOrEqual(1);
  if ((page.viewportSize()?.width ?? 1440) <= 680) {
    const small = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'main button, main select, main textarea, main summary, main input:not([type="hidden"]), header button',
        ),
      ).flatMap((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (
          !node.checkVisibility({ checkVisibilityCSS: true }) ||
          !box.width ||
          !box.height ||
          style.visibility === 'hidden'
        )
          return [];
        const target = node.matches('input[type="checkbox"], input[type="radio"]')
          ? (node.closest('label')?.getBoundingClientRect() ?? box)
          : box;
        return target.height < 43.5
          ? [
              `${node.tagName} ${node.getAttribute('type') ?? ''} ${node.getAttribute('id') ?? ''} ${node.getAttribute('class') ?? ''} ${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 45)}: ${target.height}`,
            ]
          : [];
      }),
    );
    expect(small, `${name}: phone touch targets`).toEqual([]);
  }
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${out}${name}.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
}

for (const [device, viewport] of Object.entries({
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
})) {
  for (const theme of ['dark'] as const) {
    test(`${device} ${theme}: every destination and task thread`, async ({ page }) => {
      test.setTimeout(90_000);
      page.setDefaultTimeout(15_000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const api = await installFixtures(page, routes);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const [id, label] of surfaces) {
        await page.goto('/');
        await expect(page.locator('#task-input')).toBeVisible();
        if (label) await navigate(page, label);
        if (id === 'home') {
          expect(
            await page.locator('.composer').evaluate((node) => getComputedStyle(node).position),
          ).not.toMatch(/fixed|sticky/);
          await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
          const composerBeforeSetup = await page.evaluate(() => {
            const composer = document.querySelector('.composer');
            const setup = document.querySelector('.launch-blockers');
            return (
              !setup ||
              Boolean(composer && composer.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING)
            );
          });
          expect(composerBeforeSetup).toBe(true);
        }
        await verifyAndCapture(page, `${device}-${theme}-${id}`);
      }
      await navigate(page, 'Runs & history');
      await page.locator('[data-run-id="fixture-run-001"]').click();
      await expect(page.getByRole('tablist', { name: 'Run sections' })).toBeVisible();
      await verifyAndCapture(page, `${device}-${theme}-thread`);
      await navigate(page, 'Grand Projects');
      await page.getByRole('button', { name: /^Fixture: retry backoff for the Atlas client/ }).click();
      await expect(
        page.getByRole('heading', { name: 'Fixture: retry backoff for the Atlas client' }),
      ).toBeVisible();
      await verifyAndCapture(page, `${device}-${theme}-goal-detail`);
      expect(errors).toEqual([]);
      expect(api.unmapped).toEqual([]);
      writeFileSync(
        `${out}${device}-${theme}-requests.json`,
        JSON.stringify({ requests: api.calls, unmapped: api.unmapped, pageErrors: errors }, null, 2),
      );
    });
  }
}

test('dark appearance stays dark under a light system preference and across reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const api = await installFixtures(page, routes);
  await page.goto('/');
  await expect(page.locator('#task-input')).toBeVisible();
  const canvas = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
  expect(await canvas()).toBe('#181818');
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#181818');
  await navigate(page, 'Settings');
  await expect(page.getByLabel('Theme', { exact: true })).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await canvas()).toBe('#181818');
  await page.reload();
  await expect(page.locator('#task-input')).toBeVisible();
  expect(await canvas()).toBe('#181818');
  expect(api.calls.filter((call) => /^(POST|PUT|PATCH|DELETE) /.test(call))).toEqual([]);
  expect(api.unmapped).toEqual([]);
});
