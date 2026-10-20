import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS } from './playwright.config';
import { installFixtures } from './fixtures/mockApi';
import {
  CODEX_CONNECTION,
  GO_CONNECTION,
  OPENROUTER_CONNECTION,
  providerUxRoutes,
  type ProviderScenario,
} from './fixtures/providerUx';

/**
 * Provider setup, workflow editor and JEV Decision Gate: behaviour checks and "after" evidence. Fixture-only: no real
 * provider, account, CLI or model is involved, so nothing here shows that any live provider works.
 *   npm run e2e:screenshots -- e2e/providerUx.spec.ts
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/provider-ux/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const SIZES = { desktop: VIEWPORTS['desktop-1440x900'], phone: VIEWPORTS['iphone-390x844'] } as const;
type Size = keyof typeof SIZES;

async function open(page: Page, size: Size, scenario: ProviderScenario = 'mixed') {
  await page.setViewportSize(SIZES[size]);
  await installFixtures(
    page,
    providerUxRoutes({
      scenario,
      profiles: [GO_CONNECTION, CODEX_CONNECTION, OPENROUTER_CONNECTION],
    }) as never,
  );
  await page.goto('/');
  await expect(page.locator('#task-input')).toBeVisible();
}

async function goTo(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  if (!(await nav.first().isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
  await nav.getByRole('button', { name: new RegExp(`^${label}`) }).click();
  await expect(page.locator('.topbar-title')).toHaveText(label);
  await page.waitForTimeout(250);
}

const stageToggle = (page: Page, name: string) =>
  page.locator('.stage-list .stage-row-toggle').filter({ hasText: name }).first();

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page must not scroll sideways').toBeLessThanOrEqual(1);
}

for (const size of ['desktop', 'phone'] as const) {
  test.describe(`workflow editor (${size})`, () => {
    test('stages are in the foreground, collapsed, with one primary Save', async ({ page }) => {
      await open(page, size);
      await goTo(page, 'Workflows');

      await expect(page.getByRole('list', { name: 'Stages' })).toBeVisible();
      await expect(page.locator('.stage-editor')).toHaveCount(0);
      for (const toggle of await page.locator('.stage-row-toggle').all())
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Save workflow' })).toHaveCount(1);
      await noHorizontalScroll(page);
      await page.screenshot({ path: `${OUT}workflows-${size}.png`, fullPage: size === 'phone' });
    });

    test('opens one stage editor at a time and shows inherited versus overridden settings', async ({
      page,
    }) => {
      await open(page, size);
      await goTo(page, 'Workflows');

      await stageToggle(page, 'Plan').click();
      await expect(page.locator('.stage-editor')).toHaveCount(1);
      await expect(page.locator('.stage-editor .source-chip-inherited').first()).toBeVisible();
      await page.screenshot({
        path: `${OUT}workflows-stage-inherited-${size}.png`,
        fullPage: size === 'phone',
      });

      await stageToggle(page, 'Implement').click();
      await expect(page.locator('.stage-editor')).toHaveCount(1);
      await expect(page.locator('.stage-editor .source-chip-override').first()).toBeVisible();
      await page.screenshot({
        path: `${OUT}workflows-stage-override-${size}.png`,
        fullPage: size === 'phone',
      });
      await noHorizontalScroll(page);
    });

    test('Add stage offers grouped types including a Decision gate', async ({ page }) => {
      await open(page, size);
      await goTo(page, 'Workflows');

      await page.getByText('Add stage').click();
      await expect(page.getByRole('button', { name: /Decision gate · JEV via OpenRouter/ })).toBeVisible();
      await page.screenshot({ path: `${OUT}workflows-add-stage-${size}.png` });
      await page.keyboard.press('Escape');
    });

    test('a JEV gate groups Question, Evidence and Outcome and lists prerequisites together', async ({
      page,
    }) => {
      await open(page, size);
      await goTo(page, 'Workflows');
      await page
        .getByRole('combobox', { name: /^Workflow/ })
        .selectOption({ label: 'Fixture delivery with decision' });
      await stageToggle(page, 'Ready to commit?').click();

      const editor = page.locator('.decision-gate-editor');
      await expect(editor.getByText('Before this gate can run')).toBeVisible();
      await expect(editor.getByRole('heading', { name: /1 · Question/ })).toBeVisible();
      await expect(editor.getByRole('heading', { name: /2 · Evidence/ })).toBeVisible();
      await expect(editor.getByRole('heading', { name: /3 · Outcome/ })).toBeVisible();
      await expect(editor.getByLabel('Routing summary')).toContainText('UNCERTAIN');
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}workflows-gate-${size}.png`, fullPage: size === 'phone' });
      await editor
        .locator('.decision-prerequisites')
        .screenshot({ path: `${OUT}workflows-gate-prerequisites-${size}.png` });
      await editor
        .locator('.decision-group')
        .nth(2)
        .screenshot({ path: `${OUT}workflows-gate-outcome-${size}.png` });
      await noHorizontalScroll(page);
    });

    test('a newly added JEV gate shows what is missing and enables nothing', async ({ page }) => {
      await open(page, size);
      await goTo(page, 'Workflows');
      await page.getByRole('combobox', { name: /^Workflow/ }).selectOption({ label: 'Fixture quick fix' });
      await page.getByText('Add stage').click();
      await page.getByRole('button', { name: /Decision gate · JEV via OpenRouter/ }).click();

      const editor = page.locator('.decision-gate-editor');
      await expect(editor.locator('.prerequisite')).toHaveCount(5);
      await expect(editor.locator('.prerequisite-missing').first()).toBeVisible();
      await expect(page.getByLabel('Safety and billing summary')).toContainText('Subscriptions Only');
      await page.screenshot({ path: `${OUT}workflows-gate-new-${size}.png`, fullPage: size === 'phone' });
    });

    test('unsaved edits are marked, protected on leaving, and survive a trip to Providers', async ({
      page,
    }) => {
      await open(page, size);
      await goTo(page, 'Workflows');
      await page.getByRole('textbox', { name: 'Workflow name' }).fill('Fixture delivery (edited)');
      await expect(page.getByRole('button', { name: 'Save workflow' })).toBeEnabled();
      await expect(page.locator('.save-status-dirty')).toBeVisible();
      await page.screenshot({ path: `${OUT}workflows-unsaved-${size}.png`, fullPage: size === 'phone' });

      const nav = page.getByRole('navigation', { name: 'Workspace' });
      if (!(await nav.first().isVisible()))
        await page.getByRole('button', { name: 'Open navigation' }).click();
      await nav.getByRole('button', { name: /^Projects/ }).click();
      await expect(page.getByRole('alertdialog', { name: /Leave Workflow Studio/ })).toBeVisible();
      await page.screenshot({ path: `${OUT}workflows-leave-guard-${size}.png` });
      await page.getByRole('button', { name: /keep editing/i }).click();
      // A phone keeps the navigation drawer open after a cancelled leave; close it before using the page.
      if (size === 'phone') await page.keyboard.press('Escape');

      await stageToggle(page, 'Plan').click();
      await page.getByRole('button', { name: /Set up providers/ }).click();
      await expect(page.getByRole('heading', { name: 'Providers & connections' })).toBeVisible();
      await expect(page.getByText('Your workflow draft is kept')).toBeVisible();
      await page.getByRole('button', { name: 'Back to Workflows' }).click();
      await expect(page.getByRole('textbox', { name: 'Workflow name' })).toHaveValue(
        'Fixture delivery (edited)',
      );
    });

    test('workflow settings are secondary, named panels', async ({ page }) => {
      await open(page, size);
      await goTo(page, 'Workflows');

      await page.locator('summary', { hasText: 'Safety and billing' }).click();
      await expect(page.locator('#workflow-setting-safety')).toHaveAttribute('open', '');
      await page.locator('#workflow-setting-safety').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}workflows-safety-panel-${size}.png`, fullPage: size === 'phone' });
      await noHorizontalScroll(page);
    });
  });

  test.describe(`providers and connections (${size})`, () => {
    test('one Providers & connections area with the four services', async ({ page }) => {
      await open(page, size);
      await goTo(page, 'Settings');

      await expect(page.getByRole('heading', { name: 'Providers & connections' })).toBeVisible();
      for (const name of ['OpenCode Go', 'Codex — ChatGPT subscription', 'Claude Pro / Max', 'ClinePass'])
        await expect(page.getByRole('radio', { name: new RegExp(name) })).toBeVisible();
      await page.getByRole('heading', { name: 'Providers & connections' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}settings-providers-${size}.png`, fullPage: size === 'phone' });
      await noHorizontalScroll(page);
    });

    for (const [service, shot] of [
      ['Codex — ChatGPT subscription', 'codex'],
      ['ClinePass', 'cline'],
      ['Claude Pro / Max', 'claude'],
      ['OpenCode Go', 'opencode'],
    ] as const) {
      test(`guided flow: ${service} shows separate checks and Unknown states`, async ({ page }) => {
        await open(page, size);
        await goTo(page, 'Settings');
        await page.getByRole('radio', { name: new RegExp(service) }).check({ force: true });

        const steps = page.getByRole('list', { name: /setup steps/ });
        await expect(steps).toBeVisible();
        for (const line of ['Installation', 'Authentication', 'Model catalogue', 'Last check'])
          await expect(steps.getByText(line, { exact: true }).first()).toBeVisible();
        await expect(steps.getByText(/Turing never runs these commands/)).toBeVisible();
        await steps.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${OUT}settings-flow-${shot}-${size}.png`,
          fullPage: size === 'phone',
        });
        await noHorizontalScroll(page);
      });
    }

    test('nothing is configured: Save is blocked and the reason is stated', async ({ page }) => {
      await open(page, size, 'none');
      await goTo(page, 'Settings');
      await page.getByRole('radio', { name: /OpenCode Go/ }).check({ force: true });

      await expect(page.getByRole('button', { name: 'Save connection' })).toBeDisabled();
      await expect(page.getByText(/was not detected on this Desktop Master/)).toBeVisible();
    });
  });
}

test.describe('keyboard and focus', () => {
  test('stage rows are reachable, show a focus ring, and reorder with Alt+Arrow', async ({ page }) => {
    await open(page, 'desktop');
    await goTo(page, 'Workflows');
    const first = stageToggle(page, 'Plan');
    // Keyboard modality, so :focus-visible applies the way it does for a person tabbing through the page.
    await page.getByRole('textbox', { name: 'Workflow name' }).focus();
    for (
      let step = 0;
      step < 12 && !(await first.evaluate((node) => node === document.activeElement));
      step += 1
    )
      await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    const outline = await first.evaluate(
      (node) => getComputedStyle(node).outlineStyle + getComputedStyle(node).boxShadow,
    );
    expect(outline).not.toMatch(/^none(none|$)/);

    await page.keyboard.press('Alt+ArrowDown');
    const names = await page.locator('.stage-row-name strong').allTextContents();
    expect(names.slice(0, 2)).toEqual(['Implement', 'Plan']);
    await expect(stageToggle(page, 'Plan')).toBeFocused();
  });

  test('Enter opens a stage editor and focus moves into it; Escape closes the Add stage menu', async ({
    page,
  }) => {
    await open(page, 'desktop');
    await goTo(page, 'Workflows');
    await stageToggle(page, 'Implement').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.stage-editor')).toHaveCount(1);

    await page.getByText('Add stage').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'Stage types' })).toBeVisible();
    // The menu attaches its Escape handler on the details toggle event; give it a frame, as a person always would.
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Stage types' })).toBeHidden();
  });
});

test.describe('phone ergonomics', () => {
  test('interactive controls meet 44px and the save bar does not cover the focused field', async ({
    page,
  }) => {
    await open(page, 'phone');
    await goTo(page, 'Workflows');
    await stageToggle(page, 'Implement').click();

    const small = await page.evaluate(() => {
      const selectors = [
        '.stage-row-toggle',
        '.stage-reorder .icon-button',
        '.stage-enabled',
        '.workflow-save-bar button',
        '.add-stage-menu > summary',
        '.stage-editor select',
        '.stage-editor input:not([type="checkbox"]):not([type="radio"])',
      ];
      const bad: string[] = [];
      for (const selector of selectors)
        for (const node of document.querySelectorAll<HTMLElement>(selector)) {
          const box = node.getBoundingClientRect();
          if (box.width && box.height && box.height < 43.5)
            bad.push(`${selector} ${Math.round(box.height)}px`);
        }
      return bad;
    });
    expect(small).toEqual([]);

    const field = page.locator('.stage-editor select').first();
    await field.focus();
    const covered = await page.evaluate(() => {
      const bar = document.querySelector('.workflow-save-bar')?.getBoundingClientRect();
      const active = document.activeElement?.getBoundingClientRect();
      return bar && active ? active.bottom > bar.top && active.top < bar.bottom : false;
    });
    expect(covered, 'focused field must scroll clear of the sticky save bar').toBe(false);
  });
});
