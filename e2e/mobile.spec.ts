import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MACHINE_PROFILES_KEY } from '../src/client/machineProfiles';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import { FIXTURE_TASK } from './fixtures/populated';
import { mobileRoutes } from './fixtures/mobile';
import { SETTINGS_MACHINE_PROFILES, SETTINGS_ORIGINS, SETTINGS_PAIRING_REQUIRED } from './fixtures/settings';

/**
 * UI.5 evidence capture and phone geometry (UI5_SCOPE sections 5 and 6, matrix M2 to M12). Fixture-only and deterministic:
 * every API call is answered from `fixtures/mobile.ts`, which layers the UI.2, UI.3 and UI.4 fixture sets unchanged. Their
 * values are invented and labelled as fixtures. The viewport, dark scheme, reduced motion and blocked service workers come
 * from `playwright.config.ts`; the clock and the two-identical-frames capture are the same as `settings-pages.spec.ts`.
 *
 * Chromium is not WebKit and it reports every env(safe-area-inset-*) as 0. The safe-area checks below read computed
 * declarations only. They are labelled "not verified on device" in the evidence and in the report, never as a device result.
 *
 * Not part of `npm test` (vitest excludes e2e/) or the CI gate. Run with:
 *   npx playwright test -c e2e/playwright.config.ts e2e/mobile.spec.ts
 * Images are written to docs/ui/evidence/ui5/after/ as `<capture>-<viewport>.png`.
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui5/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES: ViewportName[] = ['iphone-375x812', 'iphone-390x844'];

/** Failed in its Test stage. Its Changes tab has a three-file diff. */
const FAILED_RUN = 'fixture-run-005';
/** Running in its Implement stage. Its detail shows the intervention box and the Stop control. */
const RUNNING_RUN = 'fixture-run-001';
/** The Goal whose cockpit has mixed milestone statuses. */
const ACTIVE_GOAL = 'Fixture: retry backoff for the Atlas client';

/**
 * Named by the cockpit's own copy. Any of these on a phone would be a completion, correction, attestation or apply control.
 * Anchored to the start of a control's own text: a Goal row's description can mention an attestation or a dispute without
 * being one, and the Goal title always comes first in that text.
 */
const COMPLETION_CONTROL =
  /^(?:Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request|Apply|Attest|Approve definition)\b/i;
/** Any button, link or field named like a billing fallback or an automatic paid lane. */
const FALLBACK_CONTROL = /fallback|auto(?:matic(?:ally)?)?[ -]?pa(?:id|y)|pay[ -]as[ -]you[ -]go|payg/i;
/** Credential material in visible text: key prefixes, bearer or cookie headers, token or password assignments. */
const CREDENTIAL_TEXT = /sk-or-|sk-[A-Za-z0-9]{8,}|bearer\s+\S|set-cookie|cookie:|token=|password=/i;

/** Writes the machine profiles into localStorage before the app reads them. Runs in the page, so it takes its data as an argument. */
function seedMachineProfiles(seed: { key: string; value: unknown }) {
  try {
    window.localStorage.setItem(seed.key, JSON.stringify(seed.value));
  } catch {
    // Storage is blocked; the Machines page then shows no saved profiles, which the captures would make visible.
  }
}

/**
 * Pins the clock and answers every API call from the UI.5 fixtures. The machine health probes are answered here too, so no
 * device is reached: the online origin answers, the offline origin fails, and the checking origin never answers.
 */
async function openApp(page: Page, viewport: ViewportName, options: { pairingRequired?: boolean } = {}) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, mobileRoutes);
  await page.route(`${SETTINGS_ORIGINS.online}/api/health`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ok: true, service: 'turing-terminal' }),
    }),
  );
  await page.route(`${SETTINGS_ORIGINS.offline}/api/health`, (route) => route.abort('failed'));
  // The checking origin is deliberately never answered, so its row keeps the Checking state for the capture.
  await page.route(`${SETTINGS_ORIGINS.checking}/api/health`, () => {
    // Intentional hang: see the comment above.
  });
  if (options.pairingRequired) {
    await page.route('**/api/dashboard', (route) =>
      route.fulfill({
        status: SETTINGS_PAIRING_REQUIRED.status,
        contentType: 'application/json',
        body: JSON.stringify(SETTINGS_PAIRING_REQUIRED.body),
      }),
    );
  }
  await page.addInitScript(seedMachineProfiles, {
    key: MACHINE_PROFILES_KEY,
    value: SETTINGS_MACHINE_PROFILES,
  });
  // Freeze the fake clock one second after FIXED_NOW, so elapsed-time labels cannot drift between frames.
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

/** Opens a Workspace destination from the drawer, which is the navigation on the phone. */
async function goTo(page: Page, label: string) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click();
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

/** Opens a Workspace page from the drawer and waits for its heading. */
async function openPage(page: Page, label: string, heading: string) {
  await openHome(page);
  await goTo(page, label);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/** Opens one Goal from the Grand Projects list and waits for its cockpit heading. */
async function openGoal(page: Page, title: string) {
  await openPage(page, 'Grand Projects', 'Grand Projects');
  await expect(page.getByRole('button', { name: title })).toBeVisible();
  await page.getByRole('button', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** Types the fixture task and asks for a preview with the composer's own button. The preview enables Start workflow. */
async function requestPreview(page: Page) {
  await page.locator('#task-input').fill(FIXTURE_TASK);
  await page.getByRole('button', { name: 'Review run preview' }).click();
  await expect(page.getByRole('button', { name: 'Start workflow' })).toBeEnabled();
}

/** Every visible control on the page: its text, its accessible label and its option text. */
async function controlTexts(page: Page): Promise<string[]> {
  return page
    .locator(
      'button, a, select, option, input, textarea, [role="button"], [role="switch"], [role="checkbox"]',
    )
    .evaluateAll((elements) =>
      elements.map((element) =>
        `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`.trim(),
      ),
    );
}

/** The buttons on the page that COMPLETION_CONTROL names. */
async function completionControls(page: Page): Promise<string[]> {
  return (await page.getByRole('button').allTextContents())
    .map((text) => text.trim())
    .filter((name) => COMPLETION_CONTROL.test(name));
}

/** No fallback or auto-paid control anywhere in the captured pages (UI4 section 4, carried into UI.5). */
async function expectNoFallbackControl(page: Page) {
  const offending = (await controlTexts(page)).filter((text) => FALLBACK_CONTROL.test(text));
  expect(offending, 'no billing fallback or auto-paid control').toEqual([]);
}

/** No credential value, header or cookie text in what the page shows. */
async function expectNoCredentialText(page: Page) {
  const visible = await page.evaluate(() => document.body.innerText);
  expect(visible, 'no credential text in the visible page').not.toMatch(CREDENTIAL_TEXT);
}

/** The phone must not scroll sideways: the document and the page content both fit the width. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const content = document.querySelector('.page-content');
    return {
      document: root.scrollWidth - root.clientWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
    };
  });
  expect(overflow.document, 'the document must not scroll sideways').toBeLessThanOrEqual(0);
  expect(overflow.content, 'the page content must not scroll sideways').toBeLessThanOrEqual(0);
}

/** The phone has no completion, correction, attestation or apply control in the DOM (M12). */
async function expectNoCompletionControl(page: Page) {
  expect(await completionControls(page), 'no completion control on the phone').toEqual([]);
}

/**
 * Every visible control in the shell, the page content, the palette and the toast reaches 44px in both dimensions
 * (UI5_SCOPE item 8, matrix M3). Native checkboxes and radios are excluded because their label is the target and is checked
 * on its own. Elements that are clipped to a sliver, hidden, or inert behind the drawer are not targets, so they are skipped.
 */
async function expectTouchTargets(page: Page) {
  const misses = await page.evaluate(() => {
    const selector =
      'button, a[href], [role="button"], [role="tab"], summary, select, textarea, input:not([type="checkbox"]):not([type="radio"])';
    // The drawer is only a target while it is open. Once closed it is hidden, and its slide-out takes 180ms to finish.
    const containers = ['.topbar', '.sidebar.sidebar-open', '.page-content', '.palette', '.toast'];
    const seen = new Set<Element>();
    const misses: string[] = [];
    for (const container of containers) {
      for (const root of document.querySelectorAll(container)) {
        for (const element of root.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          if (element.closest('[inert]')) continue;
          const style = getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const box = element.getBoundingClientRect();
          if (box.width <= 2 || box.height <= 2) continue;
          if (box.width < 44 || box.height < 44) {
            const label =
              (element.textContent ?? '').trim().slice(0, 40) || element.getAttribute('aria-label') || '';
            misses.push(
              `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0] ?? ''} "${label}" ${Math.round(box.width)}x${Math.round(box.height)}`,
            );
          }
        }
      }
    }
    return misses;
  });
  expect(misses, 'every visible phone control is at least 44px').toEqual([]);
}

/** Two boxes overlap when their rectangles share any area. Edges that only touch do not count. */
function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element has no bounding box');
  return box;
}

/** Shared end of every capture: API coverage, control and credential checks, phone geometry, then the frame. */
async function settle(page: Page, viewport: ViewportName, api: MockApi, file: string) {
  expect(api.unmapped, 'every API call must be answered by a fixture').toEqual([]);
  await expectNoFallbackControl(page);
  await expectNoCredentialText(page);
  await expectNoHorizontalOverflow(page);
  await expectNoCompletionControl(page);
  await expectTouchTargets(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, `${file}-${viewport}`);
}

for (const viewport of VIEWPORT_NAMES) {
  test(`home with blockers ahead of the recent list at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    const blockers = page.getByRole('group', { name: /Before you can run/ });
    await expect(blockers).toBeVisible();
    // M5: the blockers sit above the Recent list and above the docked composer.
    const blockersBox = await boxOf(blockers);
    const tasksBox = await boxOf(page.locator('.home-tasks'));
    expect(blockersBox.y, 'blockers ahead of the Recent list').toBeLessThan(tasksBox.y);
    await blockers.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    const composerBox = await boxOf(page.locator('.home-column > .composer'));
    const reachable = await boxOf(blockers);
    expect(
      reachable.y + reachable.height,
      'blockers end above the composer once scrolled to',
    ).toBeLessThanOrEqual(composerBox.y);
    // Bottom cushion (review finding 8): at the end of the scroll the docked composer keeps 16px clear of the bottom edge.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const endComposer = await boxOf(page.locator('.home-column > .composer'));
    expect(
      endComposer.y + endComposer.height,
      'the composer clears the bottom edge at the end of the scroll',
    ).toBeLessThanOrEqual(VIEWPORTS[viewport].height - 16);
    // The end-of-scroll frame is captured as it is: settle() would scroll back to the top first.
    await expect(page.locator('.home-column > .composer-hint')).toBeVisible();
    await capture(page, `home-end-${viewport}`);
    await settle(page, viewport, api, 'home-blockers');
  });

  test(`runs list at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await goTo(page, 'Runs & history');
    await expect(page.locator(`[data-run-id="${RUNNING_RUN}"]`)).toBeVisible();
    await settle(page, viewport, api, 'runs-list');
  });

  test(`running run detail at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openRun(page, RUNNING_RUN);
    await expect(page.getByText('Now: Implement')).toBeVisible();
    // M6: the intervention box never overlaps the last stage row, once that row is scrolled into view.
    const lastRow = page.locator('.run-stage-row').last();
    await lastRow.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    const intervention = page.locator('.intervention-box');
    await expect(intervention).toBeVisible();
    expect(
      intersects(await boxOf(lastRow), await boxOf(intervention)),
      'the intervention box does not overlap the last stage row',
    ).toBe(false);
    // Computed: the textarea is capped in dvh, so a long intervention scrolls inside its own field.
    const capped = await page
      .locator('.intervention-box textarea')
      .evaluate((element) => getComputedStyle(element).maxHeight);
    expect(capped, 'the intervention textarea has a cap').not.toBe('none');
    await settle(page, viewport, api, 'run-running');
  });

  test(`run diff at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openRun(page, FAILED_RUN);
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByRole('heading', { name: 'fixture/ledger/totals.ts' })).toBeVisible();
    // M7: the diff pane contains its own overscroll and names its horizontal scroll signal.
    const pane = page.locator('.run-diff-pane');
    const overscroll = await pane.evaluate((element) => getComputedStyle(element).overscrollBehaviorY);
    expect(overscroll, 'the diff pane contains its overscroll').toBe('contain');
    // Review finding 8: the inline end of the pane fades, so a cut-off line reads as more content.
    const mask = await pane.evaluate((element) => getComputedStyle(element).maskImage);
    expect(mask, 'the diff pane fades its inline end').not.toBe('none');
    await settle(page, viewport, api, 'run-diff');
  });

  test(`grand projects list at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, 'Grand Projects', 'Grand Projects');
    await expect(page.getByText('Needs you').first()).toBeVisible();
    await settle(page, viewport, api, 'grand-projects-list');
  });

  test(`grand projects cockpit at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openGoal(page, ACTIVE_GOAL);
    await expect(page.getByText('Retry policy').first()).toBeVisible();
    await settle(page, viewport, api, 'grand-projects-cockpit');
  });

  test(`usage at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, 'Usage', 'Usage');
    await expect(page.locator('.provenance-badge', { hasText: 'Locally measured 96' })).toBeVisible();
    // Review finding 8: six date ranges in three columns. "Custom" shares its row with "30d", so it does not wrap alone.
    const custom = await boxOf(page.getByRole('button', { name: 'Custom' }));
    const thirtyDays = await boxOf(page.getByRole('button', { name: '30d' }));
    expect(Math.abs(custom.y - thirtyDays.y), '"Custom" shares a row with "30d"').toBeLessThan(1);
    await settle(page, viewport, api, 'usage');
  });

  test(`machines at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, 'Machines', 'Machines');
    await expect(page.getByText('Fixture laptop master')).toBeVisible();
    await expect(page.getByText('Checking', { exact: true })).toBeVisible();
    // Review finding 8: Connect and Remove share one row, at the same 44px minimum height and the same centre line.
    const connect = await boxOf(page.getByRole('button', { name: 'Connect' }).first());
    const remove = await boxOf(page.getByRole('button', { name: 'Remove Fixture desk master' }));
    expect(connect.height, 'Connect is a 44px target').toBeGreaterThanOrEqual(44);
    expect(remove.height, 'Remove is a 44px target').toBeGreaterThanOrEqual(44);
    expect(
      Math.abs(connect.y + connect.height / 2 - (remove.y + remove.height / 2)),
      'aligned centre lines',
    ).toBeLessThan(1);
    await settle(page, viewport, api, 'machines');
  });

  test(`settings at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, 'Settings', 'Settings');
    await expect(page.getByText('Fixture retired phone')).toBeVisible();
    await settle(page, viewport, api, 'settings');
  });

  test(`pairing at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport, { pairingRequired: true });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Connect this device' })).toBeVisible();
    await expect(page.getByLabel('Pairing code')).toBeVisible();
    await settle(page, viewport, api, 'pairing');
  });

  test(`command palette at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await page.getByRole('button', { name: 'Open command palette' }).click();
    const palette = page.locator('.palette');
    await expect(palette).toBeVisible();
    // M8: the last command, once scrolled to inside the listbox, ends above the hint, which sits outside the scroll area.
    const lastOption = page.locator('.palette-option').last();
    const hint = page.locator('.palette-hint');
    await expect(hint).toBeVisible();
    await lastOption.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
    const optionBox = await boxOf(lastOption);
    const hintBox = await boxOf(hint);
    expect(optionBox.y + optionBox.height, 'the last palette row clears the hint').toBeLessThanOrEqual(
      hintBox.y,
    );
    await settle(page, viewport, api, 'palette-open');
  });

  test(`navigation drawer at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('.sidebar.sidebar-open')).toBeVisible();
    // Computed: the drawer and the topbar read the safe-area env() sums, so the gutters are the token values.
    const gutter = await page
      .locator('.sidebar')
      .evaluate((element) => getComputedStyle(element).paddingLeft);
    expect(gutter, 'drawer gutter, computed (not verified on device)').toBe('12px');
    await settle(page, viewport, api, 'drawer-open');
  });

  test(`error toast persists at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    await requestPreview(page);
    // A genuine failure: the desktop master refuses the start request, and its message becomes the notice. This route is
    // registered after the fixtures, so Playwright matches it first; every other method falls through to the fixtures.
    await page.route('**/api/runs', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The desktop master refused to start this run.' }),
      });
    });
    await page.getByRole('button', { name: 'Start workflow' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('refused to start this run');
    await expect(toast).toHaveClass(/toast-error/);
    // M4: the toast clears the Start button, which sits in the docked composer.
    expect(
      intersects(await boxOf(toast), await boxOf(page.getByRole('button', { name: 'Start workflow' }))),
      'the toast does not intersect the Start button',
    ).toBe(false);
    // An error notice keeps its whole text: it is not clamped, and an overlong message scrolls inside its own box.
    const overflowY = await toast
      .locator('.toast-text')
      .evaluate((element) => getComputedStyle(element).overflowY);
    expect(overflowY, 'the error text can be scrolled to its end').toBe('auto');
    // Error notices never auto-dismiss: two minutes of fake time later the toast is still shown.
    await page.clock.runFor(120_000);
    await expect(toast).toBeVisible();
    await settle(page, viewport, api, 'toast-error');
  });

  test(`preview-ready toast is not an error and auto-dismisses at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openHome(page);
    // The preview-ready notice says "before starting". It is a success, so it is neither red nor sticky.
    await requestPreview(page);
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Run preview is ready');
    await expect(toast).not.toHaveClass(/toast-error/);
    await settle(page, viewport, api, 'toast-preview');
    // Non-error notices clear on their own: the 82-character text waits its 6000 ms floor, then the toast is gone.
    await page.clock.runFor(10_000);
    await expect(toast).toHaveCount(0);
  });

  test(`status toast dismisses at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openRun(page, RUNNING_RUN);
    await page.getByRole('button', { name: 'Stop run' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await expect(toast).not.toHaveClass(/toast-error/);
    // The clock is paused, so the notice is still shown when the frame is taken. Then fake time passes and it clears.
    const clamp = await toast
      .locator('.toast-text')
      .evaluate((element) => getComputedStyle(element).webkitLineClamp);
    expect(clamp, 'the toast text clamps to three lines').toBe('3');
    await settle(page, viewport, api, 'toast-status');
    await page.clock.runFor(10_000);
    await expect(toast).toHaveCount(0);
  });
}
