import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MACHINE_PROFILES_KEY } from '../src/client/machineProfiles';
import { VIEWPORTS } from './playwright.config';
import { FIXED_NOW } from './fixtures/dashboard';
import { installFixtures, type MockApi } from './fixtures/mockApi';
import { mobileRoutes } from './fixtures/mobile';
import { SETTINGS_MACHINE_PROFILES, SETTINGS_ORIGINS, SETTINGS_PAIRING_REQUIRED } from './fixtures/settings';

/**
 * UI.7 qualification matrix (UI0_SPEC section 8, UI.7; D-6, D-8). Fixture-only: every `/api/*` request is answered by the
 * UI.5 route table, which layers the populated base and the UI.2 to UI.4 fixture sets unchanged. No new fixture data.
 *
 * Every approved route is visited at all six harness viewports. Each visit asserts:
 *   - exactly one h1 in the DOM;
 *   - no horizontal overflow (document and `.page-content`);
 *   - no unmapped `/api` request (the harness records requests that had no fixture);
 *   - no console error or uncaught page error (known fixture-by-design exceptions are listed in CONSOLE_EXCEPTIONS);
 *   - at compact widths (<= 640 px, the app's useCompactViewport breakpoint) every visible interactive control is >= 44 px
 *     high, read as a violation list and asserted empty;
 *   - no element whose text exceeds its own box (buttons, links, tabs, chips and badges). CSS ellipsis truncation is
 *     recorded as an exception with its reason, not as a failure;
 *   - no billing fallback or automatic paid-lane control or text (D-8 / billing lane rules);
 *   - at compact widths no completion, correction, attestation or apply control in the DOM (Goal mobile restriction, D-6).
 *
 * Interaction checks: Ctrl+K and Cmd+K open the command palette and Escape closes it on every viewport wider than the
 * compact breakpoint; the navigation drawer opens and closes with Escape at 375 px.
 *
 * Screenshots: one full-page capture per route per viewport in docs/ui/evidence/ui7/after/, each written only once two
 * consecutive captures match. CAPTURE_SET selects the set; see captureWanted().
 *
 * axe colour-contrast is not run: no axe dependency exists in package.json or node_modules, and none is added.
 *
 * Outputs: docs/ui/evidence/ui7/after/SHA256SUMS (over the PNGs) and docs/ui/evidence/ui7/RESULTS.md (route x viewport
 * matrix, findings and exceptions). Per-cell JSON is kept in e2e/.artifacts/ui7-matrix/, which is gitignored.
 *
 * Not part of `npm test` or the CI gate. Run with:
 *   npm run e2e:screenshots -- e2e/qualification.spec.ts
 */

type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];
const COMPACT_MAX_WIDTH = 640;
const TOUCH_MIN_HEIGHT = 44;

const isCompact = (viewport: ViewportName): boolean => VIEWPORTS[viewport].width <= COMPACT_MAX_WIDTH;
const DESKTOP_VIEWPORTS = VIEWPORT_NAMES.filter((viewport) => !isCompact(viewport));
const DRAWER_VIEWPORT: ViewportName = 'iphone-375x812';

/**
 * 'all' captures every route at every viewport. 'reduced' captures desktop 1440x900 and phone 390x844 for every route,
 * plus the other four viewports for Home, Runs detail and the Goal cockpit. It is the fallback if 'all' exceeds the
 * 6 MB evidence budget. Checks run at every viewport in both modes; only the screenshots are limited.
 */
const CAPTURE_SET: 'all' | 'reduced' = 'reduced';
const REDUCED_ROUTES = new Set(['home', 'run-running', 'grand-project-cockpit']);

function captureWanted(route: string, viewport: ViewportName): boolean {
  if (CAPTURE_SET === 'all') return true;
  if (viewport === 'desktop-1440x900' || viewport === 'iphone-390x844') return true;
  return REDUCED_ROUTES.has(route);
}

const OUT = fileURLToPath(new URL('../docs/ui/evidence/ui7/after/', import.meta.url));
const RESULTS_MD = fileURLToPath(new URL('../docs/ui/evidence/ui7/RESULTS.md', import.meta.url));
const MATRIX = fileURLToPath(new URL('./.artifacts/ui7-matrix/', import.meta.url));

mkdirSync(OUT, { recursive: true });
mkdirSync(MATRIX, { recursive: true });

/** The Goal whose cockpit has mixed milestone statuses (the UI.3 and UI.5 fixture). */
const ACTIVE_GOAL = 'Fixture: retry backoff for the Atlas client';
/** The running fixture run. Its detail shows "Now: Implement" and the intervention box. */
const RUNNING_RUN = 'fixture-run-001';

/** Named by the Goal cockpit's own copy. Anchored to the start of a control's own text (as in mobile.spec.ts). */
const COMPLETION_CONTROL =
  /^(?:Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request|Apply|Attest|Approve definition)\b/i;
/** Any control named like a billing fallback or an automatic paid lane (as in mobile.spec.ts). */
const FALLBACK_CONTROL = /fallback|auto(?:matic(?:ally)?)?[ -]?pa(?:id|y)|pay[ -]as[ -]you[ -]go|payg/i;
/** Visible copy that offers or describes an automatic paid fallback. Matches are reported for review, not waived. */
const FALLBACK_TEXT =
  /auto(?:matic(?:ally)?)?[ -]?pa(?:id|y)|pay[ -]as[ -]you[ -]go|\bpayg\b|paid fallback|metered fallback/i;

/** Known console errors that the fixtures cause on purpose. Anything else is a finding. */
const CONSOLE_EXCEPTIONS: {
  reason: string;
  matches: (error: ConsoleError, context: { pairing: boolean }) => boolean;
}[] = [
  {
    reason:
      'Fixture by design: openApp aborts the offline machine health probe (SETTINGS_ORIGINS.offline) so the offline row can render; the browser logs the failed request.',
    matches: (error) =>
      error.url.startsWith(SETTINGS_ORIGINS.offline) && /failed to load resource/i.test(error.text),
  },
  {
    reason:
      'Fixture by design: on the device-pairing route /api/dashboard answers 401 (SETTINGS_PAIRING_REQUIRED). That response is what shows the pairing gate, so the browser logs it.',
    matches: (error, context) =>
      context.pairing && error.url.endsWith('/api/dashboard') && /status of 401/.test(error.text),
  },
];

/** Visible copy that names a paid lane only to say it is blocked. It does not offer a fallback, so it is an exception. */
const NEGATIVE_PAID_COPY: { reason: string; pattern: RegExp }[] = [
  {
    reason:
      'Negative policy copy on Workflows: it states that OpenRouter, API and PAYG lanes are blocked for metered routes. It offers no fallback. Matched on this exact sentence only; any other paid-lane text still fails.',
    pattern: /No metered route may run\. OpenRouter, API, and PAYG lanes are blocked\./g,
  },
];

const ELLIPSIS_REASON =
  'CSS text-overflow: ellipsis truncates the label by design. The truncated text is still the full text in the DOM; this was not verified against screen-reader output.';

interface ConsoleError {
  text: string;
  url: string;
}

interface Finding {
  check: string;
  selector: string;
  detail: string;
}

interface Exception {
  check: string;
  selector: string;
  reason: string;
}

interface Cell {
  row: string;
  viewport: ViewportName;
  status: 'pass' | 'fail' | 'error';
  findings: Finding[];
  exceptions: Exception[];
  screenshot: string | null;
  bytes: number | null;
  measured: { controls: number; visibleControls: number; clipCandidates: number } | null;
}

function newCell(row: string, viewport: ViewportName): Cell {
  return {
    row,
    viewport,
    status: 'pass',
    findings: [],
    exceptions: [],
    screenshot: null,
    bytes: null,
    measured: null,
  };
}

function addFinding(cell: Cell, check: string, selector: string, detail: string) {
  cell.findings.push({ check, selector, detail });
}

function finishCell(cell: Cell) {
  if (cell.status !== 'error') cell.status = cell.findings.length === 0 ? 'pass' : 'fail';
  writeFileSync(`${MATRIX}${cell.row}__${cell.viewport}.json`, JSON.stringify(cell, null, 2));
}

/** Writes the machine profiles into localStorage before the app reads them. */
function seedMachineProfiles(seed: { key: string; value: unknown }) {
  try {
    window.localStorage.setItem(seed.key, JSON.stringify(seed.value));
  } catch {
    // Storage is blocked; the Machines page then shows no saved profiles, which the capture makes visible.
  }
}

/** Pins the clock, answers every API call from the UI.5 table, and fixes the three machine origins (as mobile.spec.ts). */
async function openApp(page: Page, viewport: ViewportName, options: { pairing?: boolean } = {}) {
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
  // Deliberately never answered, so the checking row keeps its pending state.
  await page.route(`${SETTINGS_ORIGINS.checking}/api/health`, () => {
    // Intentional hang.
  });
  if (options.pairing) {
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
  await page.clock.pauseAt(new Date(Date.parse(FIXED_NOW) + 1_000));
  return api;
}

async function expectTopbar(page: Page, label: string) {
  await expect(page.locator('.topbar-title')).toHaveText(label);
}

/** Opens a Workspace destination: the drawer on the phone, the sidebar elsewhere (as mascot.spec.ts). */
async function goTo(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  if (!(await nav.first().isVisible())) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await nav.getByRole('button', { name: new RegExp(`^${escaped}`) }).click();
}

async function navigateTo(page: Page, label: string) {
  await page.goto('/');
  await expectTopbar(page, 'New task');
  await goTo(page, label);
  await expectTopbar(page, label);
}

interface RouteSpec {
  id: string;
  /** The page's name in RESULTS.md. */
  label: string;
  /** Only the device pairing screen is shown before the shell, so it is opened with the pairing-required fixture. */
  pairing?: boolean;
  open: (page: Page) => Promise<void>;
}

const ROUTES: RouteSpec[] = [
  {
    id: 'home',
    label: 'Home / New task',
    open: async (page) => {
      await page.goto('/');
      await expectTopbar(page, 'New task');
      await expect(page.locator('#task-input')).toBeVisible();
    },
  },
  { id: 'workflows', label: 'Workflows', open: (page) => navigateTo(page, 'Workflows') },
  { id: 'projects', label: 'Projects', open: (page) => navigateTo(page, 'Projects') },
  {
    id: 'grand-projects',
    label: 'Grand Projects (list)',
    open: (page) => navigateTo(page, 'Grand Projects'),
  },
  {
    id: 'grand-project-cockpit',
    label: 'Grand Project cockpit (one Goal)',
    open: async (page) => {
      await navigateTo(page, 'Grand Projects');
      await page.getByRole('button', { name: ACTIVE_GOAL }).click();
      await expect(page.getByRole('heading', { name: ACTIVE_GOAL })).toBeVisible();
    },
  },
  { id: 'runs', label: 'Runs & history (list)', open: (page) => navigateTo(page, 'Runs & history') },
  {
    id: 'run-running',
    label: 'Runs & history (running run detail)',
    open: async (page) => {
      await navigateTo(page, 'Runs & history');
      await page.locator(`[data-run-id="${RUNNING_RUN}"]`).click();
      await expect(page.getByRole('tablist', { name: 'Run sections' })).toBeVisible();
      await expect(page.getByText('Now: Implement')).toBeVisible();
    },
  },
  { id: 'usage', label: 'Usage', open: (page) => navigateTo(page, 'Usage') },
  { id: 'machines', label: 'Machines', open: (page) => navigateTo(page, 'Machines') },
  { id: 'settings', label: 'Settings', open: (page) => navigateTo(page, 'Settings') },
  {
    id: 'pairing',
    label: 'Device pairing (desktop approval gate)',
    pairing: true,
    open: async (page) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Connect this device' })).toBeVisible();
      await expect(page.getByLabel('Pairing code')).toBeVisible();
    },
  },
];

/**
 * Runs in the page. Returns everything the Node side needs to judge a route: h1s, overflow widths, undersized controls
 * (compact only), text that exceeds its box, the DOM's control names, and the visible text. No closures over Node values.
 */
interface PageSnapshot {
  h1: string[];
  documentOverflow: { scroll: number; client: number };
  contentOverflow: { scroll: number; client: number } | null;
  touchTargets: string[];
  clipped: { selector: string; kind: 'spill' | 'clipped' | 'ellipsis'; by: number }[];
  measured: { controls: number; visibleControls: number; clipCandidates: number };
  controls: string[];
  bodyText: string;
}

function inspectPage({ compact, minHeight }: { compact: boolean; minHeight: number }): PageSnapshot {
  const INTERACTIVE =
    'button, a[href], [role="button"], [role="tab"], [role="link"], [role="switch"], [role="menuitem"], summary, select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])';
  const CLIP =
    'button, a[href], [role="button"], [role="tab"], [role="link"], [class*="chip"], [class*="badge"], [class*="pill"], [class*="tag"]';
  const squash = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const describe = (element: Element): string => {
    const label = element.getAttribute('aria-label');
    const id = element.id ? `#${element.id}` : '';
    const classes =
      typeof element.className === 'string'
        ? element.className
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((name) => `.${name}`)
            .join('')
        : '';
    const text = squash(element.textContent).slice(0, 40);
    const name = label ? `[aria-label="${label}"]` : text ? ` "${text}"` : '';
    return `${element.tagName.toLowerCase()}${id}${classes}${name}`;
  };
  // checkVisibility covers display, visibility, opacity and content-visibility, so controls in a closed <details>
  // (not painted) and a file input hidden under its label (opacity 0) are not treated as targets.
  const visible = (element: Element): boolean => {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (element.closest('[inert]')) return false;
    const box = element.getBoundingClientRect();
    return box.width > 2 && box.height > 2;
  };
  const SCROLLER = ['auto', 'scroll'];
  const isScroller = (style: CSSStyleDeclaration) =>
    SCROLLER.includes(style.overflowX) || SCROLLER.includes(style.overflowY);

  const controls = Array.from(document.querySelectorAll(INTERACTIVE)).map((element) =>
    `${squash(element.textContent)} ${element.getAttribute('aria-label') ?? ''}`.trim(),
  );

  const touchTargets: string[] = [];
  if (compact) {
    for (const element of Array.from(document.querySelectorAll(INTERACTIVE))) {
      if (!visible(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.height < minHeight)
        touchTargets.push(`${describe(element)} ${Math.round(box.width)}x${Math.round(box.height)}px`);
    }
  }

  // Text that exceeds its control. Only painted text is measured:
  //  - text inside a scroll container between it and the control is reachable by scrolling, so it is skipped;
  //  - text in a visually hidden helper (a box 2 px or less across) is skipped;
  //  - the visible part of a text node is its range clipped by every clipping ancestor up to the control.
  // spill: the visible part sticks out of the control. clipped: an overflow-hidden box cuts the text off with no
  // ellipsis. ellipsis: an ellipsis truncates the label on purpose (reported as an exception, not a failure).
  const clipped: PageSnapshot['clipped'] = [];
  const RANK = { spill: 3, clipped: 2, ellipsis: 1 } as const;
  let clipCandidates = 0;
  for (const element of Array.from(document.querySelectorAll(CLIP))) {
    if (!visible(element) || isScroller(getComputedStyle(element))) continue;
    clipCandidates += 1;
    const frame = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let worst = 0;
    let kind: keyof typeof RANK | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!squash(node.textContent)) continue;
      const owner = node.parentElement ?? element;
      if (!visible(owner)) continue;
      const ownerBox = owner.getBoundingClientRect();
      if (ownerBox.width <= 2 || ownerBox.height <= 2) continue;
      const clips: DOMRect[] = [];
      let ellipsisClip = false;
      let contained = false;
      for (let el: Element | null = owner; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (el !== element && isScroller(style)) {
          contained = true;
          break;
        }
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          clips.push(el.getBoundingClientRect());
          if (style.textOverflow === 'ellipsis') ellipsisClip = true;
        }
        if (el === element) break;
      }
      if (contained) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      let visiblePart = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (const clip of clips) {
        visiblePart = {
          left: Math.max(visiblePart.left, clip.left),
          top: Math.max(visiblePart.top, clip.top),
          right: Math.min(visiblePart.right, clip.right),
          bottom: Math.min(visiblePart.bottom, clip.bottom),
        };
      }
      if (visiblePart.right <= visiblePart.left || visiblePart.bottom <= visiblePart.top) continue;
      const spill = Math.max(
        visiblePart.right - frame.right,
        frame.left - visiblePart.left,
        visiblePart.bottom - frame.bottom,
        frame.top - visiblePart.top,
      );
      const cut = Math.max(
        rect.right - frame.right,
        frame.left - rect.left,
        rect.bottom - frame.bottom,
        frame.top - rect.top,
      );
      let found: keyof typeof RANK | null = null;
      let amount = 0;
      if (spill > 1) {
        found = 'spill';
        amount = spill;
      } else if (cut > 1) {
        found = ellipsisClip ? 'ellipsis' : 'clipped';
        amount = cut;
      }
      if (found && (kind === null || RANK[found] > RANK[kind])) kind = found;
      if (found) worst = Math.max(worst, amount);
    }
    if (kind !== null && worst > 0) {
      clipped.push({ selector: describe(element), kind, by: Math.round(worst) });
    }
  }
  const measured = {
    controls: controls.length,
    visibleControls: Array.from(document.querySelectorAll(INTERACTIVE)).filter((element) => visible(element))
      .length,
    clipCandidates: clipCandidates,
  };

  const root = document.documentElement;
  const content = document.querySelector('.page-content');
  return {
    h1: Array.from(document.querySelectorAll('h1')).map((heading) => squash(heading.textContent)),
    documentOverflow: { scroll: root.scrollWidth, client: root.clientWidth },
    contentOverflow: content ? { scroll: content.scrollWidth, client: content.clientWidth } : null,
    touchTargets,
    clipped,
    controls,
    bodyText: document.body.innerText,
    measured,
  };
}

/** Waits up to 3 s for a locator to reach a state. Returns whether it did, so a failure is recorded rather than thrown. */
async function settles(locator: ReturnType<Page['locator']>, state: 'visible' | 'hidden'): Promise<boolean> {
  return locator.waitFor({ state, timeout: 3_000 }).then(
    () => true,
    () => false,
  );
}

/** Records console errors and uncaught exceptions from the moment it is called. */
function collectConsoleErrors(page: Page): () => ConsoleError[] {
  const errors: ConsoleError[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ text: message.text(), url: message.location().url });
  });
  page.on('pageerror', (error) => errors.push({ text: `pageerror: ${error.message}`, url: '' }));
  return () => errors;
}

/** A full-page capture taken only when two consecutive frames match. Returns the file's size, or null if it never settled. */
async function captureFull(page: Page, file: string): Promise<number | null> {
  await page.evaluate(() => document.fonts.ready);
  let previous = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(200);
    const next = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    if (next.equals(previous)) {
      writeFileSync(`${OUT}${file}`, next);
      return next.length;
    }
    previous = next;
  }
  return null;
}

function checkLayout(cell: Cell, snapshot: PageSnapshot) {
  if (snapshot.h1.length !== 1) {
    addFinding(
      cell,
      'h1-count',
      'h1',
      `${snapshot.h1.length} h1 elements in the DOM: ${JSON.stringify(snapshot.h1)}`,
    );
  }
  if (snapshot.documentOverflow.scroll > snapshot.documentOverflow.client) {
    addFinding(
      cell,
      'horizontal-overflow',
      'html',
      `document scrollWidth ${snapshot.documentOverflow.scroll} > clientWidth ${snapshot.documentOverflow.client}`,
    );
  }
  const content = snapshot.contentOverflow;
  if (content && content.scroll > content.client) {
    addFinding(
      cell,
      'horizontal-overflow',
      '.page-content',
      `scrollWidth ${content.scroll} > clientWidth ${content.client}`,
    );
  }
  for (const target of snapshot.touchTargets) {
    addFinding(
      cell,
      'touch-target-44px',
      target,
      `interactive control is shorter than ${TOUCH_MIN_HEIGHT} px`,
    );
  }
  for (const clip of snapshot.clipped) {
    if (clip.kind === 'ellipsis') {
      cell.exceptions.push({
        check: 'text-overflow (ellipsis)',
        selector: clip.selector,
        reason: ELLIPSIS_REASON,
      });
    } else if (clip.kind === 'spill') {
      addFinding(
        cell,
        'text-exceeds-container',
        clip.selector,
        `visible text runs ${clip.by} px past the control's box`,
      );
    } else {
      addFinding(
        cell,
        'text-clipped',
        clip.selector,
        `text is cut off by an overflow-hidden box inside the control (${clip.by} px, no ellipsis)`,
      );
    }
  }
}

function checkApi(cell: Cell, api: MockApi) {
  for (const key of api.unmapped) addFinding(cell, 'unmapped-api', key, 'request had no fixture');
}

function checkConsole(cell: Cell, errors: ConsoleError[], context: { pairing: boolean }) {
  for (const error of errors) {
    const exception = CONSOLE_EXCEPTIONS.find((candidate) => candidate.matches(error, context));
    if (exception) {
      cell.exceptions.push({ check: 'console-error', selector: error.url || '-', reason: exception.reason });
    } else {
      addFinding(cell, 'console-error', error.url || '-', error.text.slice(0, 300));
    }
  }
}

function checkFallback(cell: Cell, snapshot: PageSnapshot) {
  for (const control of snapshot.controls) {
    if (FALLBACK_CONTROL.test(control))
      addFinding(cell, 'fallback-control', control, 'control named like a paid fallback');
  }
  let text = snapshot.bodyText;
  for (const copy of NEGATIVE_PAID_COPY) {
    const hits = text.match(copy.pattern)?.length ?? 0;
    for (let index = 0; index < hits; index += 1) {
      cell.exceptions.push({
        check: 'fallback-text (negative copy)',
        selector: '(visible text)',
        reason: copy.reason,
      });
    }
    text = text.replace(copy.pattern, ' ');
  }
  const match = FALLBACK_TEXT.exec(text);
  if (match) {
    const start = Math.max(0, match.index - 60);
    const snippet = text
      .slice(start, match.index + match[0].length + 60)
      .replace(/\s+/g, ' ')
      .trim();
    addFinding(cell, 'fallback-text', '(visible text)', `"${snippet}"`);
  }
}

function checkCompletion(cell: Cell, snapshot: PageSnapshot) {
  for (const control of snapshot.controls) {
    if (COMPLETION_CONTROL.test(control)) {
      addFinding(
        cell,
        'completion-control-on-phone',
        control,
        'completion, correction, attestation or apply control at a compact width',
      );
    }
  }
}

/** Measures every route at every viewport, with a per-visit cell for the matrix. */
for (const route of ROUTES) {
  for (const viewport of VIEWPORT_NAMES) {
    test(`${route.id} at ${viewport}`, async ({ page }) => {
      const cell = newCell(route.id, viewport);
      try {
        const api = await openApp(page, viewport, { pairing: route.pairing });
        const errors = collectConsoleErrors(page);
        await route.open(page);
        await page.waitForTimeout(250);
        const snapshot = await page.evaluate(inspectPage, {
          compact: isCompact(viewport),
          minHeight: TOUCH_MIN_HEIGHT,
        });
        cell.measured = snapshot.measured;
        checkLayout(cell, snapshot);
        checkApi(cell, api);
        checkConsole(cell, errors(), { pairing: route.pairing === true });
        checkFallback(cell, snapshot);
        if (isCompact(viewport)) checkCompletion(cell, snapshot);
        if (captureWanted(route.id, viewport)) {
          const file = `${route.id}-${viewport}.png`;
          const bytes = await captureFull(page, file);
          if (bytes === null)
            addFinding(cell, 'capture', file, 'the full-page capture never settled into a stable frame');
          else {
            cell.screenshot = file;
            cell.bytes = bytes;
          }
        }
      } catch (error) {
        cell.status = 'error';
        addFinding(
          cell,
          'navigation',
          route.id,
          String(error instanceof Error ? error.message : error).slice(0, 400),
        );
      } finally {
        finishCell(cell);
      }
      expect(cell.findings, `${route.id} at ${viewport}`).toEqual([]);
    });
  }
}

/** Ctrl+K and Cmd+K open the palette and Escape closes it, at every viewport wide enough for the sidebar. */
for (const viewport of DESKTOP_VIEWPORTS) {
  test(`palette opens with Ctrl/Cmd+K and closes on Escape at ${viewport}`, async ({ page }) => {
    const cell = newCell('palette', viewport);
    try {
      await openApp(page, viewport);
      await page.goto('/');
      await expectTopbar(page, 'New task');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      for (const shortcut of ['Control+k', 'Meta+k']) {
        await page.keyboard.press(shortcut);
        if (!(await settles(palette, 'visible')))
          addFinding(cell, 'palette-open', shortcut, 'palette did not open');
        await page.keyboard.press('Escape');
        if (!(await settles(palette, 'hidden'))) {
          addFinding(cell, 'palette-escape', shortcut, 'palette did not close on Escape');
          await page.keyboard.press('Control+k');
          await settles(palette, 'hidden');
        }
      }
    } catch (error) {
      cell.status = 'error';
      addFinding(
        cell,
        'navigation',
        'palette',
        String(error instanceof Error ? error.message : error).slice(0, 400),
      );
    } finally {
      finishCell(cell);
    }
    expect(cell.findings, `palette at ${viewport}`).toEqual([]);
  });
}

/** The phone navigation drawer opens from the top bar and closes with Escape, at 375 px. */
test(`navigation drawer opens and closes with Escape at ${DRAWER_VIEWPORT}`, async ({ page }) => {
  const cell = newCell('drawer', DRAWER_VIEWPORT);
  try {
    await openApp(page, DRAWER_VIEWPORT);
    await page.goto('/');
    await expectTopbar(page, 'New task');
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    const drawer = page.locator('.sidebar.sidebar-open');
    await toggle.click();
    if (!(await settles(drawer, 'visible')))
      addFinding(cell, 'drawer-open', 'Open navigation', 'drawer did not open');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      addFinding(cell, 'drawer-state', 'Open navigation', 'aria-expanded is not true while open');
    }
    await page.keyboard.press('Escape');
    if (!(await settles(drawer, 'hidden')))
      addFinding(cell, 'drawer-close', 'Escape', 'drawer did not close on Escape');
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') {
      addFinding(cell, 'drawer-state', 'Open navigation', 'aria-expanded is not false after closing');
    }
  } catch (error) {
    cell.status = 'error';
    addFinding(
      cell,
      'navigation',
      'drawer',
      String(error instanceof Error ? error.message : error).slice(0, 400),
    );
  } finally {
    finishCell(cell);
  }
  expect(cell.findings, `drawer at ${DRAWER_VIEWPORT}`).toEqual([]);
});

/** Assembles SHA256SUMS over the captured PNGs and RESULTS.md from every cell written by this run. */
test.afterAll(() => {
  const rows = [...ROUTES.map((route) => route.id), 'palette', 'drawer'];
  const knownViewports = new Set<string>(VIEWPORT_NAMES);
  // Only cells for this matrix count, so a partial run cannot pick up a stale cell from an earlier one.
  const cells: Cell[] = readdirSync(MATRIX)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(`${MATRIX}${name}`, 'utf8')) as Cell)
    .filter((cell) => rows.includes(cell.row) && knownViewports.has(cell.viewport));

  // The evidence set is exactly the screenshots this run's cells reference. Anything else in after/ is stale.
  const referenced = new Set(cells.flatMap((cell) => (cell.screenshot ? [cell.screenshot] : [])));
  for (const name of readdirSync(OUT)) {
    if (name.endsWith('.png') && !referenced.has(name)) rmSync(`${OUT}${name}`);
  }
  const sums = [...referenced].sort().map((name) => {
    const hash = createHash('sha256')
      .update(readFileSync(`${OUT}${name}`))
      .digest('hex');
    return { name, hash, bytes: statSync(`${OUT}${name}`).size };
  });
  writeFileSync(`${OUT}SHA256SUMS`, sums.map((entry) => `${entry.hash}  ${entry.name}`).join('\n') + '\n');
  const totalBytes = sums.reduce((total, entry) => total + entry.bytes, 0);

  const labelOf = new Map(ROUTES.map((route) => [route.id, route.label]));
  labelOf.set('palette', 'Command palette (Ctrl/Cmd+K, Escape)');
  labelOf.set('drawer', 'Navigation drawer (Escape)');
  const cellOf = (row: string, viewport: ViewportName) =>
    cells.find((cell) => cell.row === row && cell.viewport === viewport);

  const columnHead = VIEWPORT_NAMES.map((viewport) => `${viewport.replace(/^[a-z]+-/, '')}`);
  const matrix = [
    `| Route | ${columnHead.join(' | ')} |`,
    `|---|${VIEWPORT_NAMES.map(() => '---').join('|')}|`,
  ];
  for (const row of rows) {
    const cellsText = VIEWPORT_NAMES.map((viewport) => {
      const cell = cellOf(row, viewport);
      if (!cell) return 'n/a';
      if (cell.status === 'error') return 'ERROR';
      const exceptionNote = cell.exceptions.length ? ` (${cell.exceptions.length} exc.)` : '';
      return cell.status === 'pass'
        ? `PASS${exceptionNote}`
        : `FAIL (${cell.findings.length})${exceptionNote}`;
    });
    matrix.push(`| ${labelOf.get(row) ?? row} | ${cellsText.join(' | ')} |`);
  }

  const failing = cells.filter((cell) => cell.status !== 'pass');
  const findingLines = failing.flatMap((cell) =>
    cell.findings.map(
      (finding) =>
        `- ${labelOf.get(cell.row) ?? cell.row} @ ${cell.viewport} · \`${finding.check}\` · selector \`${finding.selector}\` · ${finding.detail}`,
    ),
  );
  const exceptionLines = cells.flatMap((cell) =>
    cell.exceptions.map(
      (exception) =>
        `- ${labelOf.get(cell.row) ?? cell.row} @ ${cell.viewport} · \`${exception.check}\` · \`${exception.selector}\` · ${exception.reason}`,
    ),
  );
  const captured = cells.filter((cell) => cell.screenshot !== null).length;
  const coverage = cells.reduce(
    (total, cell) => ({
      controls: total.controls + (isCompact(cell.viewport) ? (cell.measured?.visibleControls ?? 0) : 0),
      clips: total.clips + (cell.measured?.clipCandidates ?? 0),
    }),
    { controls: 0, clips: 0 },
  );
  const cellCount = cells.length;
  const passCount = cells.filter((cell) => cell.status === 'pass').length;

  const markdown = [
    '# UI.7 qualification results',
    '',
    'Generated by `e2e/qualification.spec.ts` from fixtures only (no master, provider or live data). Same run, same output: no timestamps.',
    '',
    `Summary: ${cellCount} route and interaction cells, ${passCount} pass, ${cellCount - passCount} fail or error. ${captured} full-page screenshots, ${totalBytes} bytes (capture set \`${CAPTURE_SET}\`; budget 6 MB, ${totalBytes > 6_000_000 ? `OVER budget by ${totalBytes - 6_000_000} bytes` : 'within budget'}). Checksums: \`after/SHA256SUMS\`.`,
    '',
    '## Matrix',
    '',
    'PASS and FAIL are per route at each viewport. "(n exc.)" counts exceptions with a stated reason. n/a means the check does not apply at that width.',
    '',
    ...matrix,
    '',
    '## Findings (failures, for owner review; src was not changed)',
    '',
    ...(findingLines.length ? findingLines : ['None.']),
    '',
    '## Exceptions (allowed, with reasons)',
    '',
    ...(exceptionLines.length ? exceptionLines : ['None.']),
    '',
    '## Coverage',
    '',
    `- Visible interactive controls measured for the 44 px rule (compact widths only, <= 640 px): ${coverage.controls} controls across ${cells.filter((cell) => isCompact(cell.viewport)).length} compact cells.`,
    `- Text-bearing controls (buttons, links, tabs, chips and badges) checked for text that exceeds its box, at every viewport: ${coverage.clips} controls.`,
    '',
    '## Scope notes',
    '',
    '- Touch targets: height is checked against 44 px (as the spec states), at the compact widths (<= 640 px, the useCompactViewport breakpoint). Width is not checked here; mobile.spec.ts checks both.',
    '- Full-page captures show the document only. A container that scrolls inside the page is captured at its top.',
    '- Contrast: not run. No axe dependency exists in package.json or node_modules, and none was added.',
    '- Palette: Ctrl+K and Meta+K are checked at 1920, 1440, 1280 and 1024 px (every width above the compact breakpoint).',
    '- Drawer: opens from "Open navigation" and closes with Escape at 375 px. Its scrim close is not checked here.',
    '- Text overflow: a text node is measured only when it is painted. Text inside a scroll container, a closed details panel or a visually hidden helper (box 2 px or less) is skipped. A spill is visible text outside its control. A cut is text clipped by an overflow-hidden box inside the control with no ellipsis. Ellipsis truncation is an exception.',
    '- Visibility: controls are counted only when checkVisibility() reports them rendered, which excludes closed details content and opacity-0 inputs.',
    '- Physical devices, native shells and live providers were not tested.',
    '',
    '## Screenshots',
    '',
    ...sums.map((entry) => `- \`after/${entry.name}\` (${entry.bytes} bytes)`),
    '',
  ].join('\n');
  writeFileSync(RESULTS_MD, markdown);
});
