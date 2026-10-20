import { expect, test } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { installFixtures } from './fixtures/mockApi';

/**
 * Harness smoke tests. They prove the screenshot workflow is deterministic and fixture-only. They deliberately assert
 * nothing about the visual design, which is reviewed by people against the packet, and they replace no behavioural test.
 */
test.describe('screenshot harness', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`renders the shell from fixtures only at ${name}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      const api = await installFixtures(page);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await info.attach(`shell-${name}`, {
        body: await page.screenshot({ fullPage: false }),
        contentType: 'image/png',
      });
      expect(api.unmapped, 'every API call must be answered by a fixture').toEqual([]);
      expect(api.calls).toContain('GET /api/dashboard');
    });
  }

  test('two captures of the same state are byte-identical', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS['desktop-1440x900']);
    await installFixtures(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const first = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const second = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    expect(Buffer.compare(first, second)).toBe(0);
  });

  test('an unmapped API request is reported, not hidden', async ({ page }) => {
    const api = await installFixtures(page, {});
    await page.goto('/');
    await page.evaluate(() => fetch('/api/not-a-real-endpoint'));
    expect(api.unmapped).toContain('GET /api/not-a-real-endpoint');
  });
});
