import type { Page } from '@playwright/test';
import { FIXED_NOW, emptyDashboard } from './dashboard';

type Handler = unknown | ((url: URL, method: string) => unknown);

const defaultRoutes: Record<string, Handler> = {
  '/api/dashboard': emptyDashboard,
  '/api/providers': { providers: [] },
  '/api/rules': { rules: [] },
};

export interface MockApi {
  /** Every `/api/*` request the page made, as `METHOD path`. */
  readonly calls: string[];
  /** Requests with no fixture. Tests assert this is empty so nothing silently depends on live data. */
  readonly unmapped: string[];
}

/** Pin the clock and answer `/api/*` from fixtures. Unmapped requests get a 404 and are recorded. */
export async function installFixtures(page: Page, routes: Record<string, Handler> = {}): Promise<MockApi> {
  const table = { ...defaultRoutes, ...routes };
  const api: MockApi = { calls: [], unmapped: [] };
  await page.clock.install({ time: new Date(FIXED_NOW) });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    api.calls.push(key);
    const handler = table[url.pathname];
    if (handler === undefined) {
      api.unmapped.push(key);
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"error":"fixture_missing"}',
      });
      return;
    }
    const body =
      typeof handler === 'function'
        ? (handler as (u: URL, m: string) => unknown)(url, request.method())
        : handler;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return api;
}
