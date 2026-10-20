import { defineConfig } from '@playwright/test';

/**
 * Deterministic UI screenshot harness (UI programme, D-8). Scope: evidence for visual review, not a CI gate.
 *
 * - The Vite dev server serves the real client; every `/api/*` request is answered by fixtures (see `fixtures/mockApi.ts`).
 *   No master, provider, secret or network service is involved.
 * - Time, locale, timezone, colour scheme and reduced motion are pinned; animations are disabled for screenshots.
 * - Browser binaries live in the Playwright user cache, never in the repository.
 * - Not part of `npm test` or the CI gate. Run with `npm run e2e:screenshots`.
 */
export const VIEWPORTS = {
  'desktop-1920x1080': { width: 1920, height: 1080 },
  'desktop-1440x900': { width: 1440, height: 900 },
  'laptop-1280x800': { width: 1280, height: 800 },
  'compact-1024x768': { width: 1024, height: 768 },
  'iphone-390x844': { width: 390, height: 844 },
  'iphone-375x812': { width: 375, height: 812 },
} as const;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: './.artifacts/results',
  snapshotPathTemplate: './.artifacts/snapshots/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  },
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide' } },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4173 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
