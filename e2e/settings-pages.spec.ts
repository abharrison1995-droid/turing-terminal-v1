import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MACHINE_PROFILES_KEY } from '../src/client/machineProfiles';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import {
  SETTINGS_MACHINE_PROFILES,
  SETTINGS_ORIGINS,
  SETTINGS_PAIRING_REQUIRED,
  SETTINGS_QR_REQUEST,
  settingsRoutes,
} from './fixtures/settings';

/**
 * UI.4 evidence capture (UI4_SCOPE section 6). Fixture-only and deterministic: every API call is answered from
 * `fixtures/settings.ts` (on top of `populated.ts`), whose values are invented and labelled as fixtures. The clock, the dark
 * scheme, reduced motion, the blocked service workers and the two-identical-frames capture are the same as `goal-cockpit.spec.ts`.
 *
 * Two inputs are not plain fixtures. `/api/dashboard` answers 401 for the pairing-needed captures, which the fixture
 * table cannot express, so the spec overrides that one route. The machine health probes are answered by the spec too, so
 * no device is ever reached: the online origin answers, the offline origin fails, and the checking origin never answers.
 *
 * Not part of `npm test` (vitest excludes e2e/) or the CI gate. Run with:
 *   npx playwright test -c e2e/playwright.config.ts e2e/settings-pages.spec.ts
 * Images are written to docs/ui/evidence/ui4/after/ as `<capture>-<viewport>.png`.
 */
const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui4/after/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type ViewportName = keyof typeof VIEWPORTS;
const DESKTOP: ViewportName = 'desktop-1440x900';
const PHONE: ViewportName = 'iphone-390x844';
const VIEWPORT_NAMES: ViewportName[] = [DESKTOP, PHONE];

/** Any button, link or field named like a billing fallback or an automatic paid lane. The pairing page's "fallback code" is copy, not a control. */
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
 * Pins the clock and answers every API call from the UI.4 fixtures. Routes registered after installFixtures take
 * precedence, so the probe and pairing overrides below answer before the `**\/api/**` fallback sees the request.
 */
async function openApp(page: Page, viewport: ViewportName, options: { pairingRequired?: boolean } = {}) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  const api = await installFixtures(page, settingsRoutes);
  await page.route(`${SETTINGS_ORIGINS.online}/api/health`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ok: true, service: 'turing-terminal' }),
    }),
  );
  await page.route(`${SETTINGS_ORIGINS.offline}/api/health`, (route) => route.abort('failed'));
  // The checking origin is deliberately never answered, so its row keeps the Checking state for the capture. The handler
  // neither fulfils, continues nor aborts the request, so it stays pending on purpose. Do not "fix" this into a reply.
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
  // Freeze the fake clock one second after FIXED_NOW, as in ui1c, ui2 and ui3, so elapsed-time labels cannot drift.
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  return api;
}

/** The shell is ready once the top-bar title renders. */
async function ready(page: Page) {
  await expect(page.locator('.topbar-title')).toBeVisible();
}

/**
 * Scrolls a section so its top sits just below the sticky top bar, which otherwise covers the first rows of the element
 * screenshot. The bar's own scroll container is the one that moves; with no inner scroller the window moves instead.
 */
async function revealBelowTopbar(target: Locator) {
  await target.evaluate((element) => {
    const bar = document.querySelector<HTMLElement>('.topbar');
    const barHeight = bar ? bar.getBoundingClientRect().height : 0;
    const gap = 16;
    element.scrollIntoView({ block: 'start' });
    let scroller: HTMLElement | null = bar?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (scroller) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - barHeight - gap);
    } else {
      window.scrollBy(0, -(barHeight + gap));
    }
  });
}

/** Writes a frame only once two consecutive screenshots match, so an overlay or a focus move cannot land mid-state. */
async function capture(page: Page, file: string, target?: Locator) {
  const shot = () =>
    target
      ? target.screenshot({ animations: 'disabled', caret: 'hide' })
      : page.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => document.fonts.ready);
  if (target) await revealBelowTopbar(target);
  let previous = await shot();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(200);
    const next = await shot();
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

/** No fallback or auto-paid control in any of the four pages (UI4_SCOPE section 4, B1). */
async function expectNoFallbackControl(page: Page) {
  const offending = (await controlTexts(page)).filter((text) => FALLBACK_CONTROL.test(text));
  expect(offending, 'no billing fallback or auto-paid control').toEqual([]);
}

/** No credential value, header or cookie text in what the page shows (UI4_SCOPE section 3, K1). */
async function expectNoCredentialText(page: Page) {
  const visible = await page.evaluate(() => document.body.innerText);
  expect(visible, 'no credential text in the visible page').not.toMatch(CREDENTIAL_TEXT);
}

/** On the compact shell the page must not scroll sideways, so every frame at 390px fits the width (UI4_SCOPE section 6). */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const content = document.querySelector('.page-content');
    return {
      document: root.scrollWidth - root.clientWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
    };
  });
  expect(overflow.document, 'the document must not scroll sideways at 390px').toBeLessThanOrEqual(0);
  expect(overflow.content, 'the page content must not scroll sideways at 390px').toBeLessThanOrEqual(0);
}

/** Shared end of every capture: API coverage, the control and credential checks, then the frame. */
async function settle(page: Page, viewport: ViewportName, api: MockApi, file: string, target?: Locator) {
  expect(api.unmapped, 'every API call must be answered by a fixture').toEqual([]);
  await expectNoFallbackControl(page);
  await expectNoCredentialText(page);
  if (viewport === PHONE) await expectNoHorizontalOverflow(page);
  await page.mouse.move(0, 0);
  await capture(page, `${file}-${viewport}`, target);
}

/** Opens a Workspace page from the shell and waits for its heading. */
async function openPage(page: Page, viewport: ViewportName, label: string, heading: string) {
  await page.goto('/');
  await ready(page);
  await goTo(page, viewport, label);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

for (const viewport of VIEWPORT_NAMES) {
  test(`pairing code entry at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport, { pairingRequired: true });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Connect this device' })).toBeVisible();
    await expect(page.getByLabel('Pairing code')).toBeVisible();
    await settle(page, viewport, api, 'pairing-code');
  });

  test(`pairing QR detected at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport, { pairingRequired: true });
    await page.goto(`/?pairRequest=${SETTINGS_QR_REQUEST}`);
    await expect(
      page.getByText('QR pairing request detected. The desktop owner must approve this phone.'),
    ).toBeVisible();
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);
    await settle(page, viewport, api, 'pairing-qr');
  });

  test(`settings sections at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, viewport, 'Settings', 'Settings');
    await expect(page.getByText('Fixture retired phone')).toBeVisible();
    await expect(page.getByText('Fixture OpenRouter connection')).toBeVisible();
    // Two columns from 1100px (settings-grid), one column on the phone. Computed, so a cascade override would fail here.
    const columns = await page
      .locator('.settings-grid')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns, 'settings grid tracks').toBe(viewport === DESKTOP ? 2 : 1);
    // mobile.css sets the compact section padding (16px, --s-4) at 680px and below; desktop keeps 20px (--s-5).
    const sectionPadding = await page
      .locator('.settings-section')
      .first()
      .evaluate((element) => getComputedStyle(element).paddingLeft);
    expect(sectionPadding, 'settings section padding').toBe(viewport === DESKTOP ? '20px' : '16px');
    await settle(page, viewport, api, 'settings-top');
    await settle(page, viewport, api, 'settings-devices', page.locator('.pairing-settings'));
    await settle(
      page,
      viewport,
      api,
      'settings-openrouter',
      page.locator('section[aria-label="OpenRouter"]'),
    );
  });

  test(`usage tiles, provenance and budget at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, viewport, 'Usage', 'Usage');
    await expect(page.locator('.provenance-badge', { hasText: 'Locally measured 96' })).toBeVisible();
    // Four calls with no usable provenance read as an Unavailable badge with its count, never as zero.
    await expect(page.locator('.provenance-badge', { hasText: 'Unavailable 4' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Daily budget: $4.20 of $10.00 committed' })).toBeVisible();
    // A null metric reads Unavailable in its tile, never zero.
    await expect(page.locator('.usage-metric', { hasText: 'Cached input' }).locator('dd')).toHaveText(
      'Unavailable',
    );
    // Tile gap: 4px on desktop from pages-settings.css, 2px on the phone from mobile.css.
    const tileGap = await page
      .locator('.usage-metric')
      .first()
      .evaluate((element) => getComputedStyle(element).rowGap);
    expect(tileGap, 'usage tile gap').toBe(viewport === DESKTOP ? '4px' : '2px');
    await settle(page, viewport, api, 'usage-top');
    await settle(
      page,
      viewport,
      api,
      'usage-budget',
      page.locator('section.usage-table-panel', {
        has: page.getByRole('heading', { name: 'Metered spend and budgets' }),
      }),
    );
  });

  test(`usage quota envelopes at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, viewport, 'Usage', 'Usage');
    await expect(page.getByText('Fixture weekly allowance')).toBeVisible();
    await expect(page.getByText('Fixture monthly requests')).toBeVisible();
    await settle(page, viewport, api, 'usage-envelopes', page.locator('.quota-envelope-panel'));
  });

  test(`machines at ${viewport}`, async ({ page }) => {
    const api = await openApp(page, viewport);
    await openPage(page, viewport, 'Machines', 'Machines');
    await expect(page.getByText('Fixture laptop master')).toBeVisible();
    // The probes settle on their own: the online origin answers, the offline origin fails, the checking origin holds.
    await expect(page.locator('.status-offline').first()).toBeVisible();
    await expect(page.getByText('Checking', { exact: true })).toBeVisible();
    await settle(page, viewport, api, 'machines');
  });
}
